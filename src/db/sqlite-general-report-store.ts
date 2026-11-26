import type { GeneralReportEntry, GeneralReportStore } from "../core/general-report-store";
import type { Job, Outcome } from "../core/job";
import type { Database, Row } from "./database";

function toEntry(row: Row): GeneralReportEntry {
  return {
    target: row.target as string,
    latestJobId: row.latest_job_id as string,
    latestOutcome: row.latest_outcome as Outcome,
    latestFinishedAt: row.latest_finished_at as string,
  };
}

/**
 * One row per (project, branch, target), holding only the latest finished job — see
 * `GeneralReportStore`'s own doc for why there is no history here. `recordFinished` upserts
 * unconditionally into SQLite, but the `WHERE` on the `DO UPDATE` makes it a no-op unless the
 * incoming job actually finished later than what is already recorded, so calling it twice for the
 * same job (or out of order for two jobs) is harmless.
 */
export class SqliteGeneralReportStore implements GeneralReportStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  recordFinished(job: Job): void {
    if (job.outcome === null || job.finishedAt === null) return;
    this.db.run(
      `INSERT INTO general_report_entries (project, branch, target, latest_job_id, latest_outcome, latest_finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, branch, target) DO UPDATE SET
         latest_job_id = excluded.latest_job_id,
         latest_outcome = excluded.latest_outcome,
         latest_finished_at = excluded.latest_finished_at,
         updated_at = excluded.updated_at
       WHERE excluded.latest_finished_at > general_report_entries.latest_finished_at`,
      job.project,
      job.ref,
      job.target,
      job.id,
      job.outcome,
      job.finishedAt,
      this.now().toISOString(),
    );
  }

  list(project: string, branch: string): readonly GeneralReportEntry[] {
    return this.db.all("SELECT * FROM general_report_entries WHERE project = ? AND branch = ? ORDER BY target", project, branch).map(toEntry);
  }
}
