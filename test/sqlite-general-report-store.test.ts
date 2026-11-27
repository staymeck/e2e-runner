import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FinishedScenario } from "../src/core/general-report-store";
import type { Job, JobPhase, NewJob, Outcome } from "../src/core/job";
import { openMemoryDatabase } from "../src/db/open-database";
import { SqliteGeneralReportStore } from "../src/db/sqlite-general-report-store";
import { SqliteJobStore } from "../src/db/sqlite-job-store";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return { project: "detox", kind: "run", ref: "iteration_1", sha: SHA, target: "login-smoke", params: null, locks: [], phases: ["scenario"], ...overrides };
}

/** A terminal Job, built from a real row (so `general_report_entries`' FK to jobs(id) is satisfied). */
function finished(row: Job, overrides: Partial<Job> = {}): Job {
  const phase: JobPhase = { position: 0, name: "scenario", status: "succeeded", exitCode: 0, signal: null, outcome: "success", startedAt: "t", finishedAt: "t" };
  return { ...row, status: "succeeded", outcome: "success", finishedAt: "2026-01-01T00:00:00.000Z", phases: [phase], ...overrides };
}

/** Shorthand for a single-scenario `recordFinished` call, as a "run" job's own report would produce. */
function one(target: string, outcome: Outcome = "success"): FinishedScenario[] {
  return [{ target, outcome }];
}

describe("SqliteGeneralReportStore", () => {
  it("records a finished job and lists it back, scoped to (project, branch)", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db, { now: () => new Date("2026-01-01T00:00:01.000Z") });

    const row = jobs.create(newJob());
    store.recordFinished(finished(row), one("login-smoke"));

    assert.deepEqual(store.list("detox", "iteration_1"), [{ target: "login-smoke", latestJobId: row.id, latestOutcome: "success", latestFinishedAt: "2026-01-01T00:00:00.000Z" }]);
    assert.deepEqual(store.list("detox", "main"), [], "a different branch sees nothing");
    assert.deepEqual(store.list("other-project", "iteration_1"), [], "a different project sees nothing");
  });

  it("overwrites the row when a newer job for the same (project, branch, target) finishes", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const first = jobs.create(newJob());
    store.recordFinished(finished(first, { finishedAt: "2026-01-01T00:00:00.000Z" }), one("login-smoke", "failure"));
    const second = jobs.create(newJob());
    store.recordFinished(finished(second, { finishedAt: "2026-01-01T00:05:00.000Z" }), one("login-smoke", "success"));

    const entries = store.list("detox", "iteration_1");
    assert.equal(entries.length, 1, "still one row per (project, branch, target), not a history of both");
    assert.deepEqual(entries[0], { target: "login-smoke", latestJobId: second.id, latestOutcome: "success", latestFinishedAt: "2026-01-01T00:05:00.000Z" });
  });

  it("ignores an older finish arriving after a newer one — a race between two onFinished calls must not regress the aggregate", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const newer = jobs.create(newJob());
    store.recordFinished(finished(newer, { finishedAt: "2026-01-01T00:05:00.000Z" }), one("login-smoke", "success"));
    const older = jobs.create(newJob());
    store.recordFinished(finished(older, { finishedAt: "2026-01-01T00:00:00.000Z" }), one("login-smoke", "failure"));

    assert.deepEqual(store.list("detox", "iteration_1"), [{ target: "login-smoke", latestJobId: newer.id, latestOutcome: "success", latestFinishedAt: "2026-01-01T00:05:00.000Z" }]);
  });

  it("tracks separate scenarios (targets) independently", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const login = jobs.create(newJob({ target: "login-smoke" }));
    const checkout = jobs.create(newJob({ target: "checkout-smoke" }));
    store.recordFinished(finished(login), one("login-smoke"));
    store.recordFinished(finished(checkout), one("checkout-smoke", "failure"));

    const entries = store.list("detox", "iteration_1");
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((e) => e.target)), new Set(["login-smoke", "checkout-smoke"]));
  });

  it("records every scenario from a single \"pipeline\" job's report under the same latestJobId", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const pipeline = jobs.create(newJob({ kind: "pipeline", target: "all" }));
    store.recordFinished(finished(pipeline), [
      { target: "login-smoke", outcome: "success" },
      { target: "checkout-smoke", outcome: "failure" },
      { target: "refund-smoke", outcome: "warning" },
    ]);

    const entries = store.list("detox", "iteration_1");
    assert.equal(entries.length, 3);
    assert.deepEqual(
      new Map(entries.map((e) => [e.target, e.latestOutcome])),
      new Map([
        ["login-smoke", "success"],
        ["checkout-smoke", "failure"],
        ["refund-smoke", "warning"],
      ]),
    );
    assert.ok(entries.every((e) => e.latestJobId === pipeline.id));
  });

  it("ignores a job with no finishedAt yet (never calls recordFinished for a non-terminal job in practice, but stays harmless if it did)", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const row = jobs.create(newJob());
    store.recordFinished({ ...row, outcome: null, finishedAt: null }, one("login-smoke"));

    assert.deepEqual(store.list("detox", "iteration_1"), []);
  });

  it("does nothing for an empty scenario list (a report with no recognizable scenarios)", () => {
    const db = openMemoryDatabase();
    const jobs = new SqliteJobStore(db);
    const store = new SqliteGeneralReportStore(db);

    const row = jobs.create(newJob());
    store.recordFinished(finished(row), []);

    assert.deepEqual(store.list("detox", "iteration_1"), []);
  });
});
