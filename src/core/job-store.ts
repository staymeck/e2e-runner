import type { Job, JobFilter, JobList, JobPage, NewJob, PhaseUpdate, TransitionDetails, JobStatus } from "./job";

export const JOB_STORE = Symbol("JOB_STORE");

/** Where jobs live. The core and the API depend on this, never on SQLite. */
export interface JobStore {
  /**
   * Creates a `queued` job with its phases pending. When `retryOf` is set it must be a
   * finished job (RetryNotAllowedError otherwise).
   */
  create(job: NewJob): Job;
  get(id: string): Job | undefined;
  list(filter?: JobFilter, page?: JobPage): JobList;
  /** Jobs with this status, oldest first (the order they must run in). */
  listByStatus(status: JobStatus): readonly Job[];
  /** Jobs that are running or cancelling: after a crash, these are the orphans. */
  listActive(): readonly Job[];
  /**
   * Moves a job to a new status atomically, releasing its resources and closing its open
   * phases when the move is final. Throws JobNotFoundError, InvalidTransitionError when the
   * move is not allowed, or InvalidDetailsError when the details do not fit the new status:
   * `succeeded` needs outcome success or warning and every phase finished; `failed` needs an
   * error (given now or recorded before) and records outcome failure.
   * `pid` is how a starting job registers its process tree.
   */
  transition(id: string, to: JobStatus, details?: TransitionDetails): Job;
  /**
   * Records a phase's progress. Only for a running or cancelling job (JobNotActiveError) and only
   * along pending -> running -> finished (InvalidPhaseTransitionError). Fields left out keep their value.
   */
  updatePhase(id: string, position: number, update: PhaseUpdate): Job;
  /** Registers a new process tree for a job that is already running (e.g. the next phase's). */
  setPid(id: string, pid: number | null): void;
}
