/**
 * Where the output of a job goes. An adapter writes what its processes print; whoever implements this decides
 * how it is stored, redacted and shown (the log files and live streaming arrive with the logs ticket).
 */
export interface JobLog {
  /** Appends text exactly as produced (it may end mid-line). Never throws: a full disk must not fail a job. */
  append(jobId: string, text: string): void;
}

export const silentJobLog: JobLog = { append: () => undefined };
