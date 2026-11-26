import * as fs from "node:fs";
import * as path from "node:path";
import { silentDiagnostics, type Diagnostics } from "../../core/diagnostics";

/** A job id is always one path segment: never empty, never `.`/`..`, never containing a separator. */
function isSafeJobId(jobId: string): boolean {
  return jobId !== "" && jobId !== "." && jobId !== ".." && path.basename(jobId) === jobId;
}

export interface ReportArchive {
  /**
   * Copies `ephemeralDir` (a run's report folder, still inside the Detox runner worktree) to a durable
   * location keyed by job id, and returns that durable path. Returns undefined, and never throws, on
   * any failure (unsafe job id, copy error) — same "must not fail the job over this" contract as the
   * rest of the executor's best-effort logging.
   */
  archive(jobId: string, ephemeralDir: string): string | undefined;
  /** Where a job's archived report would be, without touching disk. */
  pathOf(jobId: string): string;
}

/**
 * The runner worktree a job's report lives in gets `git clean -ffd`'d before the *next* job's checkout
 * (see detox-request.ts's own comment on why) — nothing protects it once this job's run() has returned.
 * Copying the whole folder (not just report.html/summary.json by name) matters because a Detox HTML
 * report can reference sibling assets (screenshots) in the same folder.
 */
export class FileReportArchive implements ReportArchive {
  constructor(
    private readonly dir: string,
    private readonly diagnostics: Diagnostics = silentDiagnostics,
  ) {}

  archive(jobId: string, ephemeralDir: string): string | undefined {
    try {
      const dest = this.pathOf(jobId);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(ephemeralDir, dest, { recursive: true });
      return dest;
    } catch (error) {
      this.diagnostics.warn({ job: jobId, error: error instanceof Error ? error.message : String(error) }, "could not archive the job's report");
      return undefined;
    }
  }

  pathOf(jobId: string): string {
    if (!isSafeJobId(jobId)) throw new Error(`Not a valid job id: ${JSON.stringify(jobId)}`);
    return path.join(this.dir, jobId);
  }
}
