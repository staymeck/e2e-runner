import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { AdapterRegistry, UnknownProjectError } from "../src/core/adapter";
import { JobAlreadyFinishedError, JobNotFoundError, type Job } from "../src/core/job";
import { JobEnqueuer, type EnqueueRequest } from "../src/core/job-enqueuer";
import { JobScheduler } from "../src/core/job-scheduler";
import type { Database } from "../src/db/database";
import { openDatabase, openMemoryDatabase } from "../src/db/open-database";
import { SqliteJobStore } from "../src/db/sqlite-job-store";
import { FAIL, FakeExecutor, OK, WARN, fakeAdapter, settle } from "./helpers/fake-adapter";
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
  it("fails instead of blocking the queue", async () => {
    const detox = fakeAdapter("detox", ["devices"]);
    const store = new SqliteJobStore(openMemoryDatabase());
    const orphan = store.create({ project: "gone", kind: "run", ref: "main", sha: SHA, target: "t", params: null, locks: ["devices"], phases: ["scenario"] });
    const live = store.create({ project: "detox", kind: "run", ref: "main", sha: SHA, target: "t", params: null, locks: ["devices"], phases: ["scenario"] });
    const scheduler = new JobScheduler(store, new AdapterRegistry([detox]));
    scheduler.kick();
    assert.equal(store.get(orphan.id)?.status, "failed");
    assert.match(store.get(orphan.id)?.error ?? "", /No adapter/);
    assert.equal(store.get(live.id)?.status, "running");
    await detox.executor.finish(live.id, OK);
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
