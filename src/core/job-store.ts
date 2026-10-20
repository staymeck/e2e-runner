import type { Job, JobFilter, JobList, JobPage, NewJob, PhaseUpdate, TransitionDetails, JobStatus } from "./job";

export const JOB_STORE = Symbol("JOB_STORE");

/** Where jobs live. The core and the API depend on this, never on SQLite. */
export interface JobStore {
  /** Creates a `queued` job with its phases pending. */
  create(job: NewJob): Job;
  get(id: string): Job | undefined;
  list(filter?: JobFilter, page?: JobPage): JobList;
  /** Jobs with this status, oldest first (the order they must run in). */
  listByStatus(status: JobStatus): readonly Job[];
  /** Jobs that are running or cancelling: after a crash, these are the orphans. */
  listActive(): readonly Job[];
  /**
   * Moves a job to a new status atomically. Throws JobNotFoundError, or InvalidTransitionError
   * when the move is not allowed from the job's current status.
   */
  transition(id: string, to: JobStatus, details?: TransitionDetails): Job;
  updatePhase(id: string, position: number, update: PhaseUpdate): Job;
  setPid(id: string, pid: number | null): void;
}
