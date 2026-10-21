import * as fs from "node:fs";
import * as path from "node:path";
import { silentDiagnostics, type Diagnostics } from "../core/diagnostics";
import type { JobLog, JobLogReader, LogChunk } from "../core/job-log";

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
export class FileJobLog implements JobLog, JobLogReader {
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

  /**
   * Never throws: a job with no log yet, an unsafe id, or a read error all read as an empty chunk at
   * the same `from`, so a caller can always retry later rather than branch on an error.
   */
  read(jobId: string, from = 0): LogChunk {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.pathOf(jobId), "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, Math.min(from, size));
      const length = size - start;
      if (length <= 0) return { text: "", nextFrom: size };
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return { text: buffer.toString("utf8"), nextFrom: size };
    } catch {
      return { text: "", nextFrom: from };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
