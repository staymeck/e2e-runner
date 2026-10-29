import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { AdapterRegistry, UnknownProjectError, type Readiness } from "../src/core/adapter";
import { JobAlreadyFinishedError, JobNotFoundError, type Job } from "../src/core/job";
import { JobEnqueuer, type EnqueueRequest } from "../src/core/job-enqueuer";
import { JobScheduler } from "../src/core/job-scheduler";
import type { Database } from "../src/db/database";
import { openDatabase, openMemoryDatabase } from "../src/db/open-database";
import { SqliteJobStore } from "../src/db/sqlite-job-store";
import { FAIL, FakeExecutor, OK, WARN, fakeAdapter, settle, sleep } from "./helpers/fake-adapter";
import { scratchDir } from "./helpers/workspace";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function request(project: string, target = "scenario-1"): EnqueueRequest {
  return { project, kind: "run", ref: "main", sha: SHA, target };
}

interface Rig {
  db: Database;
  store: SqliteJobStore;
  adapters: AdapterRegistry;
  scheduler: JobScheduler;
  enqueuer: JobEnqueuer;
}

function rig(db: Database, ...adapters: ReturnType<typeof fakeAdapter>[]): Rig {
  const store = new SqliteJobStore(db);
  const registry = new AdapterRegistry(adapters);
  const scheduler = new JobScheduler(store, registry);
  return { db, store, adapters: registry, scheduler, enqueuer: new JobEnqueuer(store, registry, scheduler) };
}

const statusOf = (r: Rig, job: Job) => r.store.get(job.id)?.status;
const heldBy = (r: Rig) => Object.fromEntries(r.db.all("SELECT resource, job_id FROM locks").map((row) => [row.resource, row.job_id]));

describe("enqueue", () => {
  it("takes resources and phases from the project's adapter, not from the caller", () => {
    const detox = fakeAdapter("detox", ["devices"], new FakeExecutor(["build", "scenario"]));
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue({ ...request("detox"), locks: ["nothing"] } as EnqueueRequest);
    assert.deepEqual(job.locks, ["devices"]);
    assert.deepEqual(job.phases.map((p) => p.name), ["build", "scenario"]);
  });

  it("rejects an unknown project and creates nothing", () => {
    const r = rig(openMemoryDatabase());
    assert.throws(() => r.enqueuer.enqueue(request("ghost")), UnknownProjectError);
    assert.equal(r.store.list().jobs.length, 0);
  });

  it("starts the job right away when nothing blocks it", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    assert.equal(statusOf(r, job), "running");
    assert.deepEqual(detox.executor.started, [`${job.id}:scenario`]);
    await detox.executor.finish(job.id, OK);
  });
});

describe("running a job", () => {
  let detox: ReturnType<typeof fakeAdapter>;
  let r: Rig;
  beforeEach(() => {
    detox = fakeAdapter("detox", ["devices"], new FakeExecutor(["build", "scenario"]));
    r = rig(openMemoryDatabase(), detox);
  });

  it("runs the phases in order and ends succeeded, releasing its resources", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    assert.deepEqual(detox.executor.started, [`${job.id}:build`], "the second phase waits for the first");
    assert.deepEqual(heldBy(r), { devices: job.id });

    await detox.executor.finish(job.id, OK, "build");
    assert.deepEqual(detox.executor.started, [`${job.id}:build`, `${job.id}:scenario`]);
    await detox.executor.finish(job.id, OK, "scenario");

    const done = r.store.get(job.id)!;
    assert.deepEqual([done.status, done.outcome], ["succeeded", "success"]);
    assert.deepEqual(done.phases.map((p) => [p.status, p.exitCode]), [["succeeded", 0], ["succeeded", 0]]);
    assert.deepEqual(heldBy(r), {});
    assert.deepEqual(detox.executor.cleaned, [[job.id, null]]);
  });

  it("records the process the adapter started", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    detox.executor.registerProcess(job.id, 4242, "build");
    assert.equal(r.store.get(job.id)?.pid, 4242);
    await detox.executor.finish(job.id, OK, "build");
    await detox.executor.finish(job.id, OK, "scenario");
    assert.equal(r.store.get(job.id)?.pid, null);
  });

  it("keeps going after a warning and ends with a warning", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, WARN, "build");
    await detox.executor.finish(job.id, OK, "scenario");
    assert.deepEqual([r.store.get(job.id)?.status, r.store.get(job.id)?.outcome], ["succeeded", "warning"]);
  });

  it("stops at the first failure, skips the rest and still cleans up", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, { ...FAIL, exitCode: 2, signal: "SIGTERM" }, "build");
    const done = r.store.get(job.id)!;
    assert.deepEqual([done.status, done.outcome], ["failed", "failure"]);
    assert.match(done.error ?? "", /build.*exit code 2/);
    assert.deepEqual(done.phases.map((p) => p.status), ["failed", "skipped"]);
    assert.equal(done.phases[0]?.signal, "SIGTERM");
    assert.equal(detox.executor.isRunning(job.id, "scenario"), false);
    assert.deepEqual(heldBy(r), {});
    assert.equal(detox.executor.cleaned.length, 1);
  });

  it("uses the error the adapter gave", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, { ...FAIL, error: "device offline" }, "build");
    assert.equal(r.store.get(job.id)?.error, "device offline");
  });

  it("turns an adapter that throws into a failed job, not a crashed service", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.crash(job.id, "adb exploded", "build");
    const done = r.store.get(job.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /adb exploded/);
    assert.deepEqual(heldBy(r), {});
  });

  it("keeps working after a cleanup that throws", async () => {
    detox.executor.cleanup = async () => {
      throw new Error("cleanup broke");
    };
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, OK, "build");
    await detox.executor.finish(job.id, OK, "scenario");
    assert.equal(r.store.get(job.id)?.status, "succeeded");
  });
});

describe("resources and order", () => {
  it("runs jobs that share a resource one at a time, in arrival order", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const [a, b, c] = [1, 2, 3].map((n) => r.enqueuer.enqueue(request("detox", `s${n}`)));
    assert.deepEqual([statusOf(r, a!), statusOf(r, b!), statusOf(r, c!)], ["running", "queued", "queued"]);

    await detox.executor.finish(a!.id, OK);
    assert.deepEqual([statusOf(r, a!), statusOf(r, b!), statusOf(r, c!)], ["succeeded", "running", "queued"]);
    await detox.executor.finish(b!.id, FAIL);
    assert.deepEqual([statusOf(r, b!), statusOf(r, c!)], ["failed", "running"], "a failure does not block the queue");
    await detox.executor.finish(c!.id, OK);
    assert.deepEqual(detox.executor.started, [a, b, c].map((job) => `${job!.id}:scenario`));
  });

  it("runs jobs that share nothing at the same time", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const web = fakeAdapter("web", ["cucumber"]);
    const free = fakeAdapter("free", []);
    const r = rig(openMemoryDatabase(), detox, web, free);
    const jobs = [r.enqueuer.enqueue(request("detox")), r.enqueuer.enqueue(request("web")), r.enqueuer.enqueue(request("free")), r.enqueuer.enqueue(request("free"))];
    assert.deepEqual(jobs.map((job) => statusOf(r, job)), ["running", "running", "running", "running"]);
    for (const [job, adapter] of [[jobs[0]!, detox], [jobs[1]!, web], [jobs[2]!, free], [jobs[3]!, free]] as const) await adapter.executor.finish(job.id, OK);
  });

  it("does not let a job wait behind one that needs something else", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const web = fakeAdapter("web", ["cucumber"]);
    const r = rig(openMemoryDatabase(), detox, web);
    const first = r.enqueuer.enqueue(request("detox"));
    const waiting = r.enqueuer.enqueue(request("detox"));
    const other = r.enqueuer.enqueue(request("web"));
    assert.deepEqual([statusOf(r, first), statusOf(r, waiting), statusOf(r, other)], ["running", "queued", "running"]);
    await detox.executor.finish(first.id, OK);
    await detox.executor.finish(waiting.id, OK);
    await web.executor.finish(other.id, OK);
  });

  it("does not let a later job take a resource an earlier waiting job needs (no starvation)", async () => {
    const holder = fakeAdapter("holder", ["devices"]);
    const both = fakeAdapter("both", ["devices", "cucumber"]);
    const web = fakeAdapter("web", ["cucumber"]);
    const r = rig(openMemoryDatabase(), holder, both, web);
    const a = r.enqueuer.enqueue(request("holder")); // holds devices
    const b = r.enqueuer.enqueue(request("both")); // needs devices + cucumber: waits
    const c = r.enqueuer.enqueue(request("web")); // needs only cucumber, which is free, but b is ahead of it
    assert.deepEqual([statusOf(r, a), statusOf(r, b), statusOf(r, c)], ["running", "queued", "queued"]);

    await holder.executor.finish(a.id, OK);
    assert.deepEqual([statusOf(r, b), statusOf(r, c)], ["running", "queued"], "b goes first");
    assert.deepEqual(heldBy(r), { devices: b.id, cucumber: b.id });
    await both.executor.finish(b.id, OK);
    assert.equal(statusOf(r, c), "running");
    await web.executor.finish(c.id, OK);
  });

  it("takes all the resources of a job or none of them", async () => {
    const holder = fakeAdapter("holder", ["devices"]);
    const both = fakeAdapter("both", ["cucumber", "devices"]);
    const r = rig(openMemoryDatabase(), holder, both);
    const a = r.enqueuer.enqueue(request("holder"));
    r.enqueuer.enqueue(request("both"));
    assert.deepEqual(heldBy(r), { devices: a.id }, "cucumber must not be left half-taken");
    await holder.executor.finish(a.id, OK);
  });
});

describe("canStart (readiness beyond a free lock)", () => {
  it("leaves a job queued, with a visible reason, when the adapter says it is not ready yet", async () => {
    const detox = { ...fakeAdapter("detox", ["devices"]), canStart: async () => ({ ready: false, reason: "esperando dispositivo X" }) };
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    await settle(); // canStart is async even when it resolves right away: the check itself takes a tick
    assert.equal(statusOf(r, job), "queued");
    assert.equal(r.scheduler.waitingReasonFor(job.id), "esperando dispositivo X");
  });

  it("starts the job, and clears its reason, once canStart later says it is ready", async () => {
    let ready = false;
    const canStart = async (): Promise<Readiness> => (ready ? { ready: true } : { ready: false, reason: "esperando dispositivo X" });
    const detox = { ...fakeAdapter("detox", ["devices"]), canStart };
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    assert.equal(statusOf(r, job), "queued");

    ready = true;
    r.scheduler.kick();
    await settle();
    assert.equal(statusOf(r, job), "running");
    assert.equal(r.scheduler.waitingReasonFor(job.id), undefined);
    await detox.executor.finish(job.id, OK);
  });

  it("does not hold back a job whose own lock is free, just because another job's canStart failed", async () => {
    const blocked = { ...fakeAdapter("blocked", ["devices"]), canStart: async () => ({ ready: false, reason: "no device" }) };
    const web = fakeAdapter("web", ["cucumber"]);
    const r = rig(openMemoryDatabase(), blocked, web);
    r.enqueuer.enqueue(request("blocked"));
    const w = r.enqueuer.enqueue(request("web"));
    await settle();
    assert.equal(statusOf(r, w), "running");
    await web.executor.finish(w.id, OK);
  });

  it("fails open: a canStart that throws does not leave the job stuck", async () => {
    const detox = {
      ...fakeAdapter("detox", ["devices"]),
      canStart: async () => {
        throw new Error("boom");
      },
    };
    const warnings: string[] = [];
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry, { info: () => undefined, warn: (_f, m) => warnings.push(m), error: () => undefined });
    const enqueuer = new JobEnqueuer(store, registry, scheduler);
    const job = enqueuer.enqueue(request("detox"));
    await settle();
    assert.equal(store.get(job.id)?.status, "running");
    assert.ok(warnings.some((m) => m.includes("could not check whether the job's resources are ready")));
    await detox.executor.finish(job.id, OK);
  });

  it("recheckIntervalMs retries a job blocked only by canStart, with no other trigger", async () => {
    let ready = false;
    const canStart = async (): Promise<Readiness> => (ready ? { ready: true } : { ready: false, reason: "esperando dispositivo X" });
    const detox = { ...fakeAdapter("detox", ["devices"]), canStart };
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry, undefined, { recheckIntervalMs: 15 });
    const enqueuer = new JobEnqueuer(store, registry, scheduler);
    const job = enqueuer.enqueue(request("detox"));
    assert.equal(store.get(job.id)?.status, "queued");

    ready = true; // nothing tells the scheduler directly; only its own timer will notice
    await sleep(60);
    assert.equal(store.get(job.id)?.status, "running");
    scheduler.stop();
    await detox.executor.finish(job.id, OK);
  });

  it("canStartTimeoutMs fails open on a canStart that never resolves, not just one that throws", async () => {
    const detox = { ...fakeAdapter("detox", ["devices"]), canStart: () => new Promise<Readiness>(() => undefined) }; // never settles
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const warnings: string[] = [];
    const scheduler = new JobScheduler(store, registry, { info: () => undefined, warn: (_f, m) => warnings.push(m), error: () => undefined }, { canStartTimeoutMs: 20 });
    const enqueuer = new JobEnqueuer(store, registry, scheduler);
    const job = enqueuer.enqueue(request("detox"));
    assert.equal(store.get(job.id)?.status, "queued");

    await sleep(60);
    assert.equal(store.get(job.id)?.status, "running", "a hung canStart must not leave the job stuck queued forever");
    assert.ok(warnings.some((m) => m.includes("took too long")));
    await detox.executor.finish(job.id, OK);
  });

  it("never leaves a stale waitingReason on a job an overlapping, slower canStart check later disagrees about", async () => {
    // Pass A's canStart for job J is slow (resolves after the test manually releases it); before it
    // resolves, pass B's own canStart (triggered by kick()) is fast and says ready, so B claims and
    // starts J. When A's slow check *then* resolves not-ready, it must not overwrite waitingReasonFor
    // with a reason for a job that is no longer waiting on anything.
    let releaseSlowCheck: (() => void) | undefined;
    let callCount = 0;
    const canStart = async (): Promise<Readiness> => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => (releaseSlowCheck = resolve));
        return { ready: false, reason: "stale: should never be recorded" };
      }
      return { ready: true };
    };
    const detox = { ...fakeAdapter("detox", ["devices"]), canStart };
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox")); // pass A starts here, immediately blocked on the slow check

    r.scheduler.kick(); // pass B: its own canStart call (callCount 2) resolves ready right away
    await settle();
    assert.equal(statusOf(r, job), "running", "pass B must have claimed and started the job");

    releaseSlowCheck?.(); // now let pass A's stale check resolve not-ready
    await settle();
    assert.equal(r.scheduler.waitingReasonFor(job.id), undefined, "a finished/running job must never carry a stale waiting reason");
    await detox.executor.finish(job.id, OK);
  });
});

describe("cancel", () => {
  let detox: ReturnType<typeof fakeAdapter>;
  let r: Rig;
  beforeEach(() => {
    detox = fakeAdapter("detox", ["devices"], new FakeExecutor(["build", "scenario"]));
    r = rig(openMemoryDatabase(), detox);
  });

  it("removes a queued job from the queue and it never runs", async () => {
    const running = r.enqueuer.enqueue(request("detox"));
    const queued = r.enqueuer.enqueue(request("detox"));
    const cancelled = await r.scheduler.cancel(queued.id);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.phases.map((p) => p.status), ["cancelled", "cancelled"]);
    await detox.executor.finish(running.id, OK, "build");
    await detox.executor.finish(running.id, OK, "scenario");
    assert.deepEqual(detox.executor.started.filter((s) => s.startsWith(queued.id)), []);
  });

  it("stops a running job, frees its resources and lets the next one start", async () => {
    const running = r.enqueuer.enqueue(request("detox"));
    const next = r.enqueuer.enqueue(request("detox"));
    const cancelling = await r.scheduler.cancel(running.id);
    assert.equal(cancelling.status, "cancelling");
    assert.deepEqual(detox.executor.cancelled, [running.id]);
    assert.equal(statusOf(r, next), "queued", "resources are still held until the job really stopped");

    await detox.executor.finish(running.id, { ...FAIL, signal: "SIGTERM" }, "build"); // the adapter killed it
    const done = r.store.get(running.id)!;
    assert.equal(done.status, "cancelled");
    assert.equal(done.phases[1]?.status, "cancelled", "the phase that never ran is cancelled, not skipped");
    assert.equal(done.error, null);
    assert.equal(statusOf(r, next), "running");
  });

  it("does not start the next phase once a cancel was requested", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await r.scheduler.cancel(job.id);
    await detox.executor.finish(job.id, OK, "build"); // it finished just before it could be stopped
    assert.equal(detox.executor.started.includes(`${job.id}:scenario`), false);
    assert.equal(r.store.get(job.id)?.status, "cancelled");
  });

  it("is idempotent while cancelling", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await r.scheduler.cancel(job.id);
    assert.equal((await r.scheduler.cancel(job.id)).status, "cancelling");
    assert.deepEqual(detox.executor.cancelled, [job.id], "the adapter is asked once");
    await detox.executor.finish(job.id, FAIL, "build");
  });

  it("refuses a job that already finished, and an unknown one", async () => {
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, OK, "build");
    await detox.executor.finish(job.id, OK, "scenario");
    await assert.rejects(r.scheduler.cancel(job.id), JobAlreadyFinishedError);
    await assert.rejects(r.scheduler.cancel("ghost"), JobNotFoundError);
  });

  it("still cancels when the adapter cannot stop the process", async () => {
    detox.executor.cancel = async () => {
      throw new Error("kill failed");
    };
    const job = r.enqueuer.enqueue(request("detox"));
    assert.equal((await r.scheduler.cancel(job.id)).status, "cancelling");
    await detox.executor.finish(job.id, FAIL, "build");
    assert.equal(r.store.get(job.id)?.status, "cancelled");
  });
});

describe("a queued job of a project without an adapter", () => {
  it("is kept for when the adapter is back, and does not block anyone", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const orphan = store.create({ project: "gone", kind: "run", ref: "main", sha: SHA, target: "t", params: null, locks: ["devices"], phases: ["scenario"] });
    const live = store.create({ project: "detox", kind: "run", ref: "main", sha: SHA, target: "t", params: null, locks: ["devices"], phases: ["scenario"] });
    const warnings: string[] = [];
    const scheduler = new JobScheduler(store, new AdapterRegistry([detox]), { info: () => undefined, error: () => undefined, warn: (_f, m) => warnings.push(m) });
    scheduler.kick();
    scheduler.kick();
    assert.equal(store.get(orphan.id)?.status, "queued");
    assert.equal(store.get(live.id)?.status, "running");
    assert.equal(warnings.length, 1, "told once, not on every kick");
    await detox.executor.finish(live.id, OK);

    const back = fakeAdapter("gone", ["devices"]);
    const next = new JobScheduler(store, new AdapterRegistry([back]));
    next.kick();
    assert.equal(store.get(orphan.id)?.status, "running");
    await back.executor.finish(orphan.id, OK);
  });
});

describe("a job that cannot be started", () => {
  class ThrowingClaimStore extends SqliteJobStore {
    constructor(db: Database, private readonly poison: string) {
      super(db);
    }
    override claim(id: string) {
      if (this.get(id)?.target === this.poison) throw new Error("disk exploded");
      return super.claim(id);
    }
  }

  it("fails that job and lets the rest of the queue run", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new ThrowingClaimStore(openMemoryDatabase(), "poison");
    const scheduler = new JobScheduler(store, new AdapterRegistry([detox]));
    const enqueuer = new JobEnqueuer(store, new AdapterRegistry([detox]), scheduler);
    const poison = enqueuer.enqueue(request("detox", "poison"));
    const fine = enqueuer.enqueue(request("detox", "fine"));
    assert.equal(store.get(poison.id)?.status, "failed");
    assert.match(store.get(poison.id)?.error ?? "", /Could not start: disk exploded/);
    assert.equal(store.get(fine.id)?.status, "running");
    await detox.executor.finish(fine.id, OK);
  });

  it("does not crash the caller when the queue cannot even be read", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    store.listByStatus = () => {
      throw new Error("db gone");
    };
    const errors: string[] = [];
    const scheduler = new JobScheduler(store, new AdapterRegistry([detox]), { info: () => undefined, warn: () => undefined, error: (_f, m) => errors.push(m) });
    // kick() never throws synchronously, but logging a *rejected* queue read (unlike every other error
    // path here, which is synchronous) only happens once that promise settles, a tick later.
    assert.doesNotThrow(() => scheduler.kick());
    await sleep(0);
    assert.deepEqual(errors, ["could not read the queue"]);
  });

  it("ignores a resource listed twice by an adapter", async () => {
    const detox = fakeAdapter("detox", ["devices", "devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    assert.deepEqual(job.locks, ["devices"]);
    assert.equal(statusOf(r, job), "running");
    await detox.executor.finish(job.id, OK);
  });
});

describe("a final status that cannot be recorded", () => {
  it("does not leave the job running and holding its resources", async () => {
    class RefusesSuccess extends SqliteJobStore {
      override transition(id: string, to: Parameters<SqliteJobStore["transition"]>[1], details?: Parameters<SqliteJobStore["transition"]>[2]) {
        if (to === "succeeded") throw new Error("store refused");
        return super.transition(id, to, details);
      }
    }
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new RefusesSuccess(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry);
    const job = new JobEnqueuer(store, registry, scheduler).enqueue(request("detox"));
    await detox.executor.finish(job.id, OK);
    assert.equal(store.get(job.id)?.status, "failed");
    assert.match(store.get(job.id)?.error ?? "", /Could not record the final status: store refused/);
    assert.equal(store.get(job.id)?.pid, null);
  });
});

describe("onFinished (STA-54)", () => {
  it("is told the now-persisted job, reportPath included, once it reaches a terminal status", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const finished: Job[] = [];
    const scheduler = new JobScheduler(store, registry, undefined, { onFinished: (job) => finished.push(job) });
    const job = new JobEnqueuer(store, registry, scheduler).enqueue(request("detox"));
    await detox.executor.finish(job.id, { ...OK, reportPath: "/reports/job.html" });
    assert.deepEqual(finished.map((j) => [j.id, j.status, j.reportPath]), [[job.id, "succeeded", "/reports/job.html"]]);
  });

  it("is not told anything when no hook was given", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    await detox.executor.finish(job.id, OK); // would throw if the scheduler assumed a hook always exists
    assert.equal(statusOf(r, job), "succeeded");
  });

  it("still runs on the forced fallback after a failed transition", async () => {
    class RefusesSuccess extends SqliteJobStore {
      override transition(id: string, to: Parameters<SqliteJobStore["transition"]>[1], details?: Parameters<SqliteJobStore["transition"]>[2]) {
        if (to === "succeeded") throw new Error("store refused");
        return super.transition(id, to, details);
      }
    }
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new RefusesSuccess(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const finished: Job[] = [];
    const scheduler = new JobScheduler(store, registry, undefined, { onFinished: (job) => finished.push(job) });
    const job = new JobEnqueuer(store, registry, scheduler).enqueue(request("detox"));
    await detox.executor.finish(job.id, OK);
    assert.deepEqual(finished.map((j) => [j.id, j.status]), [[job.id, "failed"]]);
  });
});

describe("cancel: queue effects", () => {
  it("lets later jobs start when a queued job that was holding them back is cancelled", async () => {
    const holder = fakeAdapter("holder", ["devices"]);
    const both = fakeAdapter("both", ["devices", "cucumber"]);
    const web = fakeAdapter("web", ["cucumber"]);
    const r = rig(openMemoryDatabase(), holder, both, web);
    const a = r.enqueuer.enqueue(request("holder"));
    const b = r.enqueuer.enqueue(request("both"));
    const c = r.enqueuer.enqueue(request("web"));
    assert.equal(statusOf(r, c), "queued");
    await r.scheduler.cancel(b.id);
    assert.equal(statusOf(r, c), "running", "c only waited behind b");
    await holder.executor.finish(a.id, OK);
    await web.executor.finish(c.id, OK);
  });
});

describe("process ids", () => {
  it("are cleared when a phase ends, so none is left pointing at a dead process", async () => {
    const detox = fakeAdapter("detox", ["devices"], new FakeExecutor(["build", "scenario"]));
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    detox.executor.registerProcess(job.id, 4242, "build");
    assert.equal(r.store.get(job.id)?.pid, 4242);
    await detox.executor.finish(job.id, OK, "build");
    assert.equal(r.store.get(job.id)?.status, "running");
    assert.equal(r.store.get(job.id)?.pid, null, "between phases there is no process");
    await detox.executor.finish(job.id, OK, "scenario");
  });
});

describe("cancel signal", () => {
  it("aborts the signal the phase was given, so a run that is still setting up cannot miss the cancel", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    const signal = detox.executor.signalOf(job.id);
    assert.equal(signal.aborted, false);
    await r.scheduler.cancel(job.id);
    assert.equal(signal.aborted, true);
    await detox.executor.finish(job.id, FAIL);
  });
});

describe("a run that never ends", () => {
  it("is abandoned after the cancel grace period: cleaned up, cancelled, resources freed", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry, undefined, { cancelGraceMs: 30 });
    const enqueuer = new JobEnqueuer(store, registry, scheduler);
    const stuck = enqueuer.enqueue(request("detox"));
    const next = enqueuer.enqueue(request("detox"));
    await scheduler.cancel(stuck.id); // the adapter ignores it: run() never settles
    assert.equal(store.get(stuck.id)?.status, "cancelling");
    await sleep(150);
    assert.equal(store.get(stuck.id)?.status, "cancelled");
    assert.deepEqual(detox.executor.cleaned[0], [stuck.id, null]);
    assert.equal(store.get(next.id)?.status, "running", "the queue moved on");
    await detox.executor.finish(next.id, OK);
  });

  it("fails a phase that outlives its time limit, saying so", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry, undefined, { phaseTimeoutMs: 30, cancelGraceMs: 30 });
    const job = new JobEnqueuer(store, registry, scheduler).enqueue(request("detox"));
    await sleep(200);
    const done = store.get(job.id)!;
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /Phase "scenario" timed out after 30 ms/);
    assert.deepEqual(detox.executor.cancelled, [job.id], "the adapter was told to kill it");
  });

  it("does not time out a phase that ends in time", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const registry = new AdapterRegistry([detox]);
    const scheduler = new JobScheduler(store, registry, undefined, { phaseTimeoutMs: 60, cancelGraceMs: 30 });
    const job = new JobEnqueuer(store, registry, scheduler).enqueue(request("detox"));
    await detox.executor.finish(job.id, OK);
    await sleep(120);
    assert.equal(store.get(job.id)?.status, "succeeded");
    assert.deepEqual(detox.executor.cancelled, []);
  });
});

describe("shutdown", () => {
  it("cancels what is running, waits for it and starts nothing new", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const running = r.enqueuer.enqueue(request("detox"));
    const queued = r.enqueuer.enqueue(request("detox"));
    const done = r.scheduler.shutdown(1000);
    await settle();
    assert.equal(statusOf(r, running), "cancelling");
    await detox.executor.finish(running.id, FAIL);
    await done;
    assert.equal(statusOf(r, running), "cancelled");
    assert.equal(statusOf(r, queued), "queued", "the queue is kept for the next start");
  });

  it("gives up waiting after the timeout", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    const started = Date.now();
    await r.scheduler.shutdown(40);
    assert.ok(Date.now() - started < 1000);
    assert.equal(statusOf(r, job), "cancelling", "left for the next start to reconcile");
  });
});

describe("stop", () => {
  it("stops starting jobs", () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    r.scheduler.stop();
    const job = r.enqueuer.enqueue(request("detox"));
    assert.equal(statusOf(r, job), "queued");
  });
});

describe("after a restart", () => {
  const root = scratchDir();

  it("keeps the queue, closes what was running and cleans what it left behind", async () => {
    const dir = path.join(root, "restart");
    const before = rig(openDatabase(dir), fakeAdapter("detox", ["devices"]));
    const running = before.enqueuer.enqueue(request("detox", "was-running"));
    // the first process "dies" later on: nothing ever finishes these jobs
    (before.adapters.get("detox") as ReturnType<typeof fakeAdapter>).executor.registerProcess(running.id, 777);
    const queued = before.enqueuer.enqueue(request("detox", "was-queued"));
    const cancelling = before.store.create({ project: "detox", kind: "run", ref: "main", sha: SHA, target: "was-cancelling", params: null, locks: ["cucumber"], phases: ["scenario"] });
    before.store.claim(cancelling.id);
    before.store.transition(cancelling.id, "cancelling");
    before.db.close();

    const detox = fakeAdapter("detox", ["devices"]);
    const after = rig(openDatabase(dir), detox);
    try {
      assert.equal(after.store.get(running.id)?.status, "running", "nothing has been decided yet");
      await after.scheduler.reconcile();

      const failed = after.store.get(running.id)!;
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", /Service restarted during phase "scenario"/);
      assert.equal(failed.pid, null);
      assert.equal(after.store.get(cancelling.id)?.status, "cancelled", "a cancel that was under way is honoured");
      assert.ok(detox.executor.cleaned.some(([id, pid]) => id === running.id && pid === 777), "the leftover process is handed to the adapter");

      assert.equal(after.store.get(queued.id)?.status, "running", "the queue survived and moves on");
      assert.deepEqual(Object.values(heldBy(after)), [queued.id]);
      await detox.executor.finish(queued.id, OK);
    } finally {
      after.db.close();
    }
  });

  it("reconciling twice changes nothing the second time", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    await r.scheduler.reconcile();
    await r.scheduler.reconcile();
    assert.equal(r.store.list().jobs.length, 0);
  });

  it("leaves alone the jobs this scheduler is running right now", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    await r.scheduler.reconcile();
    assert.equal(statusOf(r, job), "running");
    assert.deepEqual(detox.executor.cleaned, []);
    await detox.executor.finish(job.id, OK);
    assert.equal(statusOf(r, job), "succeeded");
  });

  it("keeps closing the other orphans when one of them cannot be closed", async () => {
    const store = new SqliteJobStore(openMemoryDatabase());
    const mk = (target: string, locks: string[]) => store.create({ project: "detox", kind: "run", ref: "main", sha: SHA, target, params: null, locks, phases: ["scenario"] });
    const first = mk("a", ["x"]);
    const second = mk("b", ["y"]);
    store.claim(first.id);
    store.claim(second.id);
    const original = store.transition.bind(store);
    store.transition = (id, to, details) => {
      if (id === first.id) throw new Error("cannot");
      return original(id, to, details);
    };
    await new JobScheduler(store, new AdapterRegistry([fakeAdapter("detox", [])])).reconcile();
    assert.equal(store.get(second.id)?.status, "failed");
  });

  it("closes an active job even when its project has no adapter any more", async () => {
    const store = new SqliteJobStore(openMemoryDatabase());
    const job = store.create({ project: "gone", kind: "run", ref: "main", sha: SHA, target: "t", params: null, locks: ["devices"], phases: ["scenario"] });
    store.claim(job.id);
    await new JobScheduler(store, new AdapterRegistry()).reconcile();
    assert.equal(store.get(job.id)?.status, "failed");
  });
});

describe("idle", () => {
  it("resolves once every started job is done", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const r = rig(openMemoryDatabase(), detox);
    const job = r.enqueuer.enqueue(request("detox"));
    let idle = false;
    void r.scheduler.idle().then(() => (idle = true));
    await settle();
    assert.equal(idle, false);
    await detox.executor.finish(job.id, OK);
    await settle();
    assert.equal(idle, true);
  });
});
