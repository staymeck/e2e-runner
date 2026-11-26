import type { Job, Outcome } from "./job";

export const GENERAL_REPORT_STORE = Symbol("GENERAL_REPORT_STORE");
/** The plain `config.reportBranch` string, injected where a controller needs it without depending on `ServiceConfig` as a whole. */
export const REPORT_BRANCH = Symbol("REPORT_BRANCH");

export interface GeneralReportEntry {
  readonly target: string;
  readonly latestJobId: string;
  readonly latestOutcome: Outcome;
  readonly latestFinishedAt: string;
}

/**
 * The "always current" aggregate shown on the Status page / `GET /v1/report/general`: one row per
 * scenario, holding only its most recent finished `run` on the tracked branch. A scenario that was
 * failing and is later re-run successfully simply overwrites its row — there is no history of the
 * earlier failure here by design (the per-job report still has it, via `latestJobId`'s own `reportPath`).
 */
export interface GeneralReportStore {
  /**
   * Upserts `(project, job.ref, job.target)` from `job`, but only if `job` is newer than whatever is
   * already recorded (or nothing is recorded yet). Never throws. The caller decides *whether* this job
   * should count at all (kind === "run", on the tracked branch, terminal) — this method itself does not
   * filter, so it stays as dumb and testable as `SqliteJobStore`.
   */
  recordFinished(job: Job): void;
  list(project: string, branch: string): readonly GeneralReportEntry[];
}
