import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { InvalidTransitionError, JobNotFoundError, canTransition, isTerminal, JOB_STATUSES, type NewJob } from "../src/core/job";
import type { Database } from "../src/db/database";
import { openDatabase, openMemoryDatabase } from "../src/db/open-database";
import { SqliteJobStore } from "../src/db/sqlite-job-store";
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

function setup() {
  const db = openMemoryDatabase();
  let tick = 0;
  let counter = 0;
  const store = new SqliteJobStore(db, {
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)),
    newId: () => `job-${++counter}`,
  });
  return { db, store };
}

describe("transitions", () => {
  it("allow exactly the documented moves", () => {
    const allowed: Record<string, string[]> = {
      queued: ["running", "cancelled"],
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

  it("links a retry to its original", () => {
    const original = ctx.store.create(newJob());
    assert.equal(ctx.store.create(newJob({ retryOf: original.id })).retryOf, original.id);
  });

  it("refuses a retry of a job that does not exist, and creates nothing", () => {
    assert.throws(() => ctx.store.create(newJob({ retryOf: "ghost" })));
    assert.equal(ctx.store.list().jobs.length, 0);
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

  it("rejects every move the state machine does not allow and leaves the job untouched", () => {
    ctx.store.create(newJob());
    assert.throws(() => ctx.store.transition("job-1", "succeeded"), InvalidTransitionError);
    ctx.store.transition("job-1", "running");
    ctx.store.transition("job-1", "succeeded");
    const before = ctx.store.get("job-1");
    for (const to of JOB_STATUSES) assert.throws(() => ctx.store.transition("job-1", to), InvalidTransitionError, to);
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

  it("closes the phases that were still open", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
    ctx.store.updatePhase("job-1", 0, { status: "running" });
    const failed = ctx.store.transition("job-1", "failed", { error: "service restarted" });
    assert.deepEqual(failed.phases.map((p) => p.status), ["failed", "skipped"]);
    assert.ok(failed.phases[0]?.finishedAt);
    assert.equal(failed.error, "service restarted");
  });

  it("marks open phases of a cancelled job as cancelled", () => {
    ctx.store.create(newJob());
    assert.deepEqual(ctx.store.transition("job-1", "cancelled").phases.map((p) => p.status), ["cancelled", "cancelled"]);
  });

  it("is atomic: a rejected move changes nothing, not even the phases", () => {
    ctx.store.create(newJob());
    const before = ctx.store.get("job-1");
    assert.throws(() => ctx.store.transition("job-1", "succeeded", { outcome: "success" }));
    assert.deepEqual(ctx.store.get("job-1"), before);
  });
});

describe("SqliteJobStore.updatePhase", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => (ctx = setup()));

  it("records progress, exit code, signal and outcome of a phase", () => {
    ctx.store.create(newJob());
    ctx.store.transition("job-1", "running");
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

  it("keeps the first start time when a phase is reported running twice", () => {
    ctx.store.create(newJob());
    const first = ctx.store.updatePhase("job-1", 0, { status: "running" }).phases[0]?.startedAt;
    assert.equal(ctx.store.updatePhase("job-1", 0, { status: "running" }).phases[0]?.startedAt, first);
  });

  it("rejects an unknown job or phase", () => {
    ctx.store.create(newJob());
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
    ctx.store.transition("job-1", "running");
    ctx.store.transition("job-1", "succeeded");
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

  it("clamps absurd page sizes", () => {
    assert.equal(ctx.store.list({}, { limit: 0 }).jobs.length, 1);
    assert.equal(ctx.store.list({}, { limit: 100000 }).jobs.length, 4);
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

describe("SqliteJobStore.setPid", () => {
  it("stores and clears the process id, and rejects an unknown job", () => {
    const { store } = setup();
    store.create(newJob());
    store.setPid("job-1", 99);
    assert.equal(store.get("job-1")?.pid, 99);
    store.setPid("job-1", null);
    assert.equal(store.get("job-1")?.pid, null);
    assert.throws(() => store.setPid("ghost", 1), JobNotFoundError);
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
    before.store.transition(first!.id, "succeeded", { outcome: "success" });
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
