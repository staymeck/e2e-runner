import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  InvalidDetailsError,
  InvalidPhaseTransitionError,
  InvalidTransitionError,
  JOB_STATUSES,
  JobNotActiveError,
  JobNotFoundError,
  RetryNotAllowedError,
  canPhaseTransition,
  canTransition,
  isTerminal,
  type NewJob,
} from "../src/core/job";
import type { Database } from "../src/db/database";
import { openDatabase, openMemoryDatabase } from "../src/db/open-database";
import { SqliteJobStore } from "../src/db/sqlite-job-store";
import { FaultyDatabase } from "./helpers/faulty-database";
import { scratchDir } from "./helpers/workspace";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    project: "detox",
    kind: "run",
    ref: "iteration_1",
    sha: SHA,
    target: "login-smoke",
    params: { retries: 1 },
    locks: ["devices"],
    phases: ["build", "scenario"],
    ...overrides,
  };
}

function storeOver(db: Database) {
  let tick = 0;
  let counter = 0;
  return new SqliteJobStore(db, {
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)),
    newId: () => `job-${++counter}`,
  });
}

function setup() {
  const db = openMemoryDatabase();
  return { db, store: storeOver(db) };
}

type Store = SqliteJobStore;

/** Runs every phase to success and finishes the job, as a normal run would. */
function complete(store: Store, id: string, outcome: "success" | "warning" = "success") {
  if (store.get(id)?.status === "queued") store.transition(id, "running");
  for (const phase of store.get(id)?.phases ?? []) {
    store.updatePhase(id, phase.position, { status: "running" });
    store.updatePhase(id, phase.position, { status: "succeeded", exitCode: 0, outcome: "success" });
  }
  return store.transition(id, "succeeded", { outcome });
}

describe("state machines", () => {
  it("allow exactly the documented job moves", () => {
    const allowed: Record<string, string[]> = {
      queued: ["running", "cancelled", "failed"],
      running: ["succeeded", "failed", "cancelling"],
      cancelling: ["cancelled", "failed"],
      succeeded: [],
      failed: [],
      cancelled: [],
    };
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        assert.equal(canTransition(from, to), allowed[from]?.includes(to) ?? false, `${from} -> ${to}`);
      }
    }
    assert.deepEqual(JOB_STATUSES.filter(isTerminal), ["succeeded", "failed", "cancelled"]);
  });

  it("only lets a phase go forward", () => {
    assert.equal(canPhaseTransition("pending", "running"), true);
    assert.equal(canPhaseTransition("running", "running"), true);
    assert.equal(canPhaseTransition("running", "succeeded"), true);
    assert.equal(canPhaseTransition("succeeded", "running"), false);
    assert.equal(canPhaseTransition("failed", "succeeded"), false);
    assert.equal(canPhaseTransition("pending", "succeeded"), false);
  });
});

describe("SqliteJobStore.create and get", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => (ctx = setup()));

  it("stores a queued job with the pinned commit, parameters, locks and pending phases", () => {
    const job = ctx.store.create(newJob());
    assert.equal(job.id, "job-1");
    assert.equal(job.status, "queued");
    assert.equal(job.sha, SHA);
    assert.deepEqual(job.params, { retries: 1 });
    assert.deepEqual(job.locks, ["devices"]);
    assert.deepEqual(job.phases.map((p) => [p.position, p.name, p.status]), [[0, "build", "pending"], [1, "scenario", "pending"]]);
    assert.equal(job.startedAt, null);
    assert.deepEqual(ctx.store.get("job-1"), job);
  });

  it("returns undefined for an unknown id", () => {
    assert.equal(ctx.store.get("nope"), undefined);
  });

  it("numbers jobs in arrival order even when they share a timestamp", () => {
    const store = new SqliteJobStore(ctx.db, { now: () => new Date(0) });
    const a = store.create(newJob());
    const b = store.create(newJob());
    assert.ok(b.seq > a.seq);
  });

  it("keeps parameters of any JSON shape, and a job without any", () => {
    assert.equal(ctx.store.create(newJob({ params: undefined })).params, null);
    assert.deepEqual(ctx.store.create(newJob({ params: { a: [1, { b: "c" }], d: null } })).params, { a: [1, { b: "c" }], d: null });
  });

  it("creates nothing at all when any insert fails (jobs and phases are one write)", () => {
    const faulty = storeOver(new FaultyDatabase(ctx.db, { failRun: (sql, count) => sql.includes("job_phases") && count >= 2 }));
    assert.throws(() => faulty.create(newJob({ phases: ["a", "b", "c"] })), /injected/);
    assert.equal(ctx.store.list().jobs.length, 0);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM job_phases")?.n, 0);
  });
});

describe("retries", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => (ctx = setup()));

  it("link to a finished job", () => {
    ctx.store.create(newJob());
    complete(ctx.store, "job-1");
    assert.equal(ctx.store.create(newJob({ retryOf: "job-1" })).retryOf, "job-1");
  });

  it("are refused while the original is queued, running or cancelling", () => {
    ctx.store.create(newJob());
    assert.throws(() => ctx.store.create(newJob({ retryOf: "job-1" })), RetryNotAllowedError);
    ctx.store.transition("job-1", "running");
    assert.throws(() => ctx.store.create(newJob({ retryOf: "job-1" })), RetryNotAllowedError);
    ctx.store.transition("job-1", "cancelling");
    assert.throws(() => ctx.store.create(newJob({ retryOf: "job-1" })), RetryNotAllowedError);
    assert.equal(ctx.store.list().jobs.length, 1, "no retry was left behind");
  });

  it("are refused when the original does not exist", () => {
    assert.throws(() => ctx.store.create(newJob({ retryOf: "ghost" })), RetryNotAllowedError);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM job_phases")?.n, 0);
  });
});

describe("SqliteJobStore.transition", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => (ctx = setup()));

  it("records when a job starts and finishes", () => {
    ctx.store.create(newJob());
    const running = ctx.store.transition("job-1", "running", { pid: 4321, logPath: "/logs/job-1.log" });
    assert.equal(running.status, "running");
    assert.ok(running.startedAt);
    assert.equal(running.pid, 4321);
    assert.equal(running.logPath, "/logs/job-1.log");

    for (const phase of running.phases) {
      ctx.store.updatePhase("job-1", phase.position, { status: "running" });
      ctx.store.updatePhase("job-1", phase.position, { status: "succeeded" });
    }
    const done = ctx.store.transition("job-1", "succeeded", { outcome: "success", reportPath: "/reports/job-1" });
    assert.ok(done.finishedAt && done.finishedAt > (done.startedAt as string));
    assert.equal(done.outcome, "success");
    assert.equal(done.reportPath, "/reports/job-1");
    assert.equal(done.pid, null, "a finished job has no process to clean up");
    assert.equal(done.logPath, "/logs/job-1.log", "paths set earlier survive");
  });

  it("keeps the pid while the job is still alive", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running", { pid: 7 });
    assert.equal(ctx.store.transition("job-1", "cancelling").pid, 7);
  });

  it("records when a cancel was requested", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    const cancelling = ctx.store.transition("job-1", "cancelling");
    assert.ok(cancelling.cancelRequestedAt);
    assert.equal(cancelling.finishedAt, null);
    assert.equal(ctx.store.transition("job-1", "cancelled").status, "cancelled");
  });

  it("fails a queued job whose commit is gone", () => {
    ctx.store.create(newJob());
    const failed = ctx.store.transition("job-1", "failed", { error: "commit no disponible" });
    assert.deepEqual([failed.status, failed.outcome, failed.startedAt], ["failed", "failure", null]);
  });

  it("rejects every move the state machine does not allow and leaves the job untouched", () => {
    ctx.store.create(newJob());
    assert.throws(() => ctx.store.transition("job-1", "succeeded", { outcome: "success" }), InvalidTransitionError);
    complete(ctx.store, "job-1");
    const before = ctx.store.get("job-1");
    for (const to of JOB_STATUSES) assert.throws(() => ctx.store.transition("job-1", to, { error: "x" }), InvalidTransitionError, to);
    assert.deepEqual(ctx.store.get("job-1"), before);
  });

  it("throws JobNotFoundError for an unknown job", () => {
    assert.throws(() => ctx.store.transition("ghost", "running"), JobNotFoundError);
  });

  it("releases the job's locks together with the final status", () => {
    ctx.store.create(newJob());
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.db.run("INSERT INTO locks (resource, job_id) VALUES ('devices', 'job-1')");
    ctx.db.run("INSERT INTO locks (resource, job_id) VALUES ('other', 'job-2')");
    ctx.store.transition("job-1", "failed", { error: "boom" });
    assert.deepEqual(ctx.db.all("SELECT resource FROM locks").map((r) => r.resource), ["other"]);
  });

  it("closes the phases that were still open, with a finish time", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    const failed = ctx.store.transition("job-1", "failed", { error: "service restarted" });
    assert.deepEqual(failed.phases.map((p) => p.status), ["failed", "skipped"]);
    assert.ok(failed.phases.every((p) => p.finishedAt));
    assert.equal(failed.error, "service restarted");
  });

  it("marks open phases of a cancelled job as cancelled, in the order they were cancelled", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    ctx.store.transition("job-1", "cancelling");
    assert.deepEqual(ctx.store.transition("job-1", "cancelled").phases.map((p) => p.status), ["cancelled", "cancelled"]);
    ctx.store.create(newJob());
    assert.deepEqual(ctx.store.transition("job-2", "cancelled").phases.map((p) => p.status), ["cancelled", "cancelled"]);
  });

  it("changes nothing when the write fails halfway (status, phases and locks stay together)", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    ctx.db.run("INSERT INTO locks (resource, job_id) VALUES ('devices', 'job-1')");
    const before = ctx.store.get("job-1");

    const faulty = storeOver(new FaultyDatabase(ctx.db, { failRun: (sql) => sql.startsWith("DELETE FROM locks") }));
    assert.throws(() => faulty.transition("job-1", "failed", { error: "x" }), /injected/);

    assert.deepEqual(ctx.store.get("job-1"), before);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM locks")?.n, 1);
  });

  describe("details must fit the new status", () => {
    beforeEach(() => {
      ctx.store.create(newJob());
      ctx.store.transition("job-1", "running");
      for (const phase of [0, 1]) {
        ctx.store.updatePhase("job-1", phase, { status: "running" });
        ctx.store.updatePhase("job-1", phase, { status: "succeeded" });
      }
    });

    it("succeeded needs outcome success or warning", () => {
      assert.throws(() => ctx.store.transition("job-1", "succeeded"), InvalidDetailsError);
      assert.throws(() => ctx.store.transition("job-1", "succeeded", { outcome: "failure" }), InvalidDetailsError);
      assert.equal(ctx.store.transition("job-1", "succeeded", { outcome: "warning" }).outcome, "warning");
    });

    it("failed needs an error and can only be a failure", () => {
      assert.throws(() => ctx.store.transition("job-1", "failed"), InvalidDetailsError);
      assert.throws(() => ctx.store.transition("job-1", "failed", { error: "x", outcome: "success" }), InvalidDetailsError);
      const failed = ctx.store.transition("job-1", "failed", { error: "x" });
      assert.deepEqual([failed.outcome, failed.error], ["failure", "x"]);
    });

    it("other statuses take no outcome", () => {
      assert.throws(() => ctx.store.transition("job-1", "cancelling", { outcome: "failure" }), InvalidDetailsError);
    });
  });

  it("does not overwrite the first error with a later one", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.db.run("UPDATE jobs SET error = 'root cause' WHERE id = 'job-1'");
    assert.equal(ctx.store.transition("job-1", "failed", { error: "consequence" }).error, "root cause");
    assert.equal(ctx.store.get("job-1")?.outcome, "failure");
  });

  it("does not let a job succeed while a phase is still open", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    ctx.store.updatePhase("job-1", 0, { status: "succeeded" });
    assert.throws(() => ctx.store.transition("job-1", "succeeded", { outcome: "success" }), InvalidDetailsError); // phase 1 pending
    assert.equal(ctx.store.get("job-1")?.status, "running");
  });

  it("lets a job without phases succeed", () => {
    ctx.store.create(newJob({ phases: [] }));
    ctx.store.transition("job-1", "running");
    assert.equal(ctx.store.transition("job-1", "succeeded", { outcome: "success" }).status, "succeeded");
  });
});

describe("SqliteJobStore.updatePhase", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
  });

  it("records progress, exit code, signal and outcome of a phase", () => {
    const started = ctx.store.updatePhase("job-1", 0, { status: "running" });
    assert.ok(started.phases[0]?.startedAt);
    assert.equal(started.phases[0]?.finishedAt, null);

    const finished = ctx.store.updatePhase("job-1", 0, { status: "failed", exitCode: 137, signal: "SIGKILL", outcome: "failure" });
    assert.deepEqual(
      [finished.phases[0]?.status, finished.phases[0]?.exitCode, finished.phases[0]?.signal, finished.phases[0]?.outcome],
      ["failed", 137, "SIGKILL", "failure"],
    );
    assert.ok(finished.phases[0]?.finishedAt);
    assert.equal(finished.phases[1]?.status, "pending");
  });

  it("keeps what was recorded when a later update leaves a field out", () => {
    ctx.store.updatePhase("job-1", 0, { status: "running", exitCode: 3, signal: "SIGTERM" });
    const later = ctx.store.updatePhase("job-1", 0, { status: "failed" });
    assert.deepEqual([later.phases[0]?.exitCode, later.phases[0]?.signal], [3, "SIGTERM"]);
  });

  it("keeps the first start time when a phase is reported running twice", () => {
    const first = ctx.store.updatePhase("job-1", 0, { status: "running" }).phases[0]?.startedAt;
    assert.equal(ctx.store.updatePhase("job-1", 0, { status: "running" }).phases[0]?.startedAt, first);
  });

  it("never moves a phase backwards or skips running", () => {
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    ctx.store.updatePhase("job-1", 0, { status: "succeeded" });
    assert.throws(() => ctx.store.updatePhase("job-1", 0, { status: "running" }), InvalidPhaseTransitionError);
    assert.throws(() => ctx.store.updatePhase("job-1", 1, { status: "succeeded" }), InvalidPhaseTransitionError);
  });

  it("is refused unless the job is running or cancelling", () => {
    ctx.store.create(newJob());
    assert.throws(() => ctx.store.updatePhase("job-2", 0, { status: "running" }), JobNotActiveError);
    ctx.store.transition("job-1", "cancelling");
    assert.doesNotThrow(() => ctx.store.updatePhase("job-1", 0, { status: "running" }));
    ctx.store.transition("job-1", "cancelled");
    assert.throws(() => ctx.store.updatePhase("job-1", 1, { status: "running" }), JobNotActiveError);
  });

  it("rejects an unknown job or phase", () => {
    assert.throws(() => ctx.store.updatePhase("ghost", 0, { status: "running" }), JobNotFoundError);
    assert.throws(() => ctx.store.updatePhase("job-1", 9, { status: "running" }), RangeError);
  });
});

describe("SqliteJobStore.list", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.store.create(newJob({ ref: "iteration_1", target: "login" })); // job-1
    ctx.store.create(newJob({ ref: "iteration_1", target: "checkout" })); // job-2
    ctx.store.create(newJob({ ref: "iteration_2", target: "login" })); // job-3
    ctx.store.create(newJob({ project: "cucumber", ref: "main", target: "login" })); // job-4
    complete(ctx.store, "job-1");
  });

  const ids = (filter = {}, page = {}) => ctx.store.list(filter, page).jobs.map((j) => j.id);

  it("lists newest first", () => {
    assert.deepEqual(ids(), ["job-4", "job-3", "job-2", "job-1"]);
  });

  it("filters by branch, including the jobs of other projects only when asked", () => {
    assert.deepEqual(ids({ ref: "iteration_1" }), ["job-2", "job-1"]);
    assert.deepEqual(ids({ project: "detox", ref: "iteration_2" }), ["job-3"]);
  });

  it("filters by scenario across branches", () => {
    assert.deepEqual(ids({ project: "detox", target: "login" }), ["job-3", "job-1"]);
  });

  it("filters by one or several statuses, and an empty list matches nothing", () => {
    assert.deepEqual(ids({ statuses: ["succeeded"] }), ["job-1"]);
    assert.deepEqual(ids({ statuses: ["queued", "succeeded"] }), ["job-4", "job-3", "job-2", "job-1"]);
    assert.deepEqual(ids({ statuses: [] }), []);
  });

  it("combines filters", () => {
    assert.deepEqual(ids({ project: "detox", ref: "iteration_1", target: "login", statuses: ["succeeded"] }), ["job-1"]);
    assert.deepEqual(ids({ project: "detox", ref: "iteration_2", statuses: ["succeeded"] }), []);
  });

  it("pages with a cursor, without repeating or skipping jobs", () => {
    const first = ctx.store.list({}, { limit: 3 });
    assert.deepEqual(first.jobs.map((j) => j.id), ["job-4", "job-3", "job-2"]);
    assert.equal(first.nextCursor, first.jobs[2]?.seq);
    const second = ctx.store.list({}, { limit: 3, before: first.nextCursor as number });
    assert.deepEqual(second.jobs.map((j) => j.id), ["job-1"]);
    assert.equal(second.nextCursor, null);
  });

  it("returns no cursor when the last page is exactly full", () => {
    assert.equal(ctx.store.list({}, { limit: 4 }).nextCursor, null);
  });

  it("clamps absurd page sizes and survives a page size that is not a number", () => {
    assert.equal(ctx.store.list({}, { limit: 0 }).jobs.length, 1);
    assert.equal(ctx.store.list({}, { limit: 100000 }).jobs.length, 4);
    assert.equal(ctx.store.list({}, { limit: Number.NaN }).jobs.length, 4);
    assert.equal(ctx.store.list({}, { limit: Number.POSITIVE_INFINITY }).jobs.length, 4);
  });

  it("treats filter values as data, never as SQL", () => {
    assert.deepEqual(ids({ ref: "x' OR '1'='1" }), []);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM jobs")?.n, 4);
  });

  it("includes each job's phases", () => {
    assert.ok(ctx.store.list().jobs.every((job) => job.phases.length === 2));
  });
});

describe("SqliteJobStore.listByStatus and listActive", () => {
  it("returns the queue oldest first and the active jobs", () => {
    const { store } = setup();
    for (let i = 0; i < 4; i++) store.create(newJob());
    store.transition("job-2", "running");
    store.transition("job-3", "running");
    store.transition("job-3", "cancelling");
    store.transition("job-4", "cancelled");
    assert.deepEqual(store.listByStatus("queued").map((j) => j.id), ["job-1"]);
    assert.deepEqual(store.listActive().map((j) => j.id), ["job-2", "job-3"]);
  });
});

describe("SqliteJobStore.claim", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => (ctx = setup()));
  const locks = () => ctx.db.all("SELECT resource, job_id FROM locks ORDER BY resource").map((r) => `${r.resource}:${r.job_id}`);

  it("takes every resource and starts the job", () => {
    ctx.store.create(newJob({ locks: ["devices", "cucumber"] }));
    const job = ctx.store.claim("job-1");
    assert.equal(job?.status, "running");
    assert.ok(job?.startedAt);
    assert.deepEqual(locks(), ["cucumber:job-1", "devices:job-1"]);
  });

  it("takes nothing when any resource is held by another job", () => {
    ctx.store.create(newJob({ locks: ["devices"] }));
    ctx.store.create(newJob({ locks: ["cucumber", "devices"] }));
    ctx.store.claim("job-1");
    assert.equal(ctx.store.claim("job-2"), undefined);
    assert.deepEqual(locks(), ["devices:job-1"], "cucumber must not stay taken");
    assert.equal(ctx.store.get("job-2")?.status, "queued");
  });

  it("starts a job that needs no resource whatever is held", () => {
    ctx.store.create(newJob({ locks: ["devices"] }));
    ctx.store.create(newJob({ locks: [] }));
    ctx.store.claim("job-1");
    assert.equal(ctx.store.claim("job-2")?.status, "running");
  });

  it("only claims a queued job, once", () => {
    ctx.store.create(newJob());
    assert.equal(ctx.store.claim("job-1")?.status, "running");
    assert.equal(ctx.store.claim("job-1"), undefined);
    assert.equal(ctx.store.claim("ghost"), undefined);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM locks")?.n, 1);
  });

  it("makes the resource available again as soon as the job finishes", () => {
    ctx.store.create(newJob());
    ctx.store.create(newJob());
    ctx.store.claim("job-1");
    assert.equal(ctx.store.claim("job-2"), undefined);
    ctx.store.transition("job-1", "failed", { error: "x" });
    assert.equal(ctx.store.claim("job-2")?.status, "running");
  });
});

describe("SqliteJobStore.setPid", () => {
  it("stores and clears the process id of a live job", () => {
    const { store } = setup();
    store.create(newJob());
    store.transition("job-1", "running");
    store.setPid("job-1", 99);
    assert.equal(store.get("job-1")?.pid, 99);
    store.setPid("job-1", null);
    assert.equal(store.get("job-1")?.pid, null);
  });

  it("refuses a queued or finished job, so a stale pid can never be killed after a restart", () => {
    const { store } = setup();
    store.create(newJob());
    assert.throws(() => store.setPid("job-1", 5), JobNotActiveError);
    complete(store, "job-1");
    assert.throws(() => store.setPid("job-1", 5), JobNotActiveError);
    assert.equal(store.get("job-1")?.pid, null);
  });

  it("rejects an unknown job", () => {
    assert.throws(() => setup().store.setPid("ghost", 1), JobNotFoundError);
  });
});

describe("a restart", () => {
  const root = scratchDir();

  function reopen(dir: string): { db: Database; store: SqliteJobStore } {
    const db = openDatabase(dir);
    return { db, store: new SqliteJobStore(db) };
  }

  it("loses neither the queue nor the history, and shows what was running", () => {
    const dir = path.join(root, "restart");
    const before = reopen(dir);
    for (let i = 0; i < 3; i++) before.store.create(newJob({ target: `scenario-${i}` }));
    const [first, second] = before.store.listByStatus("queued");
    before.store.transition(first!.id, "running", { pid: 1234 });
    complete(before.store, first!.id);
    before.store.transition(second!.id, "running", { pid: 5678 });
    before.db.close(); // the "crash"

    const after = reopen(dir);
    try {
      assert.deepEqual(after.store.listByStatus("queued").map((j) => j.target), ["scenario-2"], "queued jobs survive, in order");
      assert.deepEqual(after.store.list({ statuses: ["succeeded"] }).jobs.map((j) => j.id), [first!.id], "history survives");
      const orphans = after.store.listActive();
      assert.deepEqual(orphans.map((j) => [j.id, j.pid]), [[second!.id, 5678]], "the interrupted job and its process are known");
      assert.equal(after.store.transition(second!.id, "failed", { error: "service restarted" }).status, "failed");
    } finally {
      after.db.close();
    }
  });

  it("two connections to the same file see each other's committed jobs", () => {
    const dir = path.join(root, "two-connections");
    const writer = reopen(dir);
    const reader = reopen(dir);
    try {
      writer.store.create(newJob());
      assert.equal(reader.store.list().jobs.length, 1);
    } finally {
      writer.db.close();
      reader.db.close();
    }
  });
});
