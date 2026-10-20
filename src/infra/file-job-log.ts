import * as fs from "node:fs";
import * as path from "node:path";
import { silentDiagnostics, type Diagnostics } from "../core/diagnostics";
import type { JobLog } from "../core/job-log";

/** A job id is always one path segment: never empty, never `.`/`..`, never containing a separator. */
function isSafeJobId(jobId: string): boolean {
  return jobId !== "" && jobId !== "." && jobId !== ".." && path.basename(jobId) === jobId;
}

/**
 * Writes each job's output to its own file under `dir`, created on first use. Never throws: a job that
 * cannot be logged must still run (a full disk, a missing folder, or an unsafe job id is reported to
 * diagnostics instead). The id is not expected to be attacker-controlled (the store generates it), but
 * `pathOf` is public, so it defends itself rather than trust every future caller to pass a clean id.
 */
export class FileJobLog implements JobLog {
  private ready = false;

  constructor(
    private readonly dir: string,
    private readonly diagnostics: Diagnostics = silentDiagnostics,
  ) {}

  append(jobId: string, text: string): void {
    try {
      if (!this.ready) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.ready = true;
      }
      fs.appendFileSync(this.pathOf(jobId), text);
    } catch (error) {
      this.diagnostics.warn({ job: jobId, error: error instanceof Error ? error.message : String(error) }, "could not write to the job log");
    }
  }

  /** Where a job's log is, or would be written. Throws for a job id that is not a single path segment. */
  pathOf(jobId: string): string {
    if (!isSafeJobId(jobId)) throw new Error(`Not a valid job id: ${JSON.stringify(jobId)}`);
    return path.join(this.dir, `${jobId}.log`);
  }
}
