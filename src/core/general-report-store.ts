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
export interface FinishedScenario {
  readonly target: string;
  readonly outcome: Outcome;
}

export interface GeneralReportStore {
  /**
   * Upserts one `(project, job.ref, scenario.target)` row per entry in `scenarios`, from `job`, but only
   * if `job` is newer than whatever is already recorded for that scenario (or nothing is recorded yet).
   * Never throws. `scenarios` is keyed by its own target, not `job.target`: a "run" job's report always
   * names exactly one scenario, but a "pipeline" job's single report can cover many at once — the caller
   * (`main.ts`) is the one that reads the job's report and extracts this list; the caller also decides
   * *whether* this job should count at all (on the tracked branch, terminal, has a report) — this method
   * itself does not filter, so it stays as dumb and testable as `SqliteJobStore`.
   */
  recordFinished(job: Job, scenarios: readonly FinishedScenario[]): void;
  list(project: string, branch: string): readonly GeneralReportEntry[];
}
