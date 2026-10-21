/**
 * Where the output of a job goes. An adapter writes what its processes print; whoever implements this decides
 * how it is stored, redacted and shown (the log files and live streaming arrive with the logs ticket).
 */
export interface JobLog {
  /** Appends text exactly as produced (it may end mid-line). Never throws: a full disk must not fail a job. */
  append(jobId: string, text: string): void;
}

export const silentJobLog: JobLog = { append: () => undefined };

export interface LogChunk {
  readonly text: string;
  /** Byte offset to resume from on the next read: always the log's length at the moment it was read. */
  readonly nextFrom: number;
}

export const JOB_LOG_READER = Symbol("JOB_LOG_READER");

/** The read side of a job's log: replay from a byte offset, and the live tail polls the same way. */
export interface JobLogReader {
  /** The log from byte offset `from` (default 0) to its current end. A job with no log yet reads as empty. */
  read(jobId: string, from?: number): LogChunk;
}
