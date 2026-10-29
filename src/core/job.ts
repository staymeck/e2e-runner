export type JobStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type Outcome = "success" | "warning" | "failure";

export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled"];

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  // `failed` from `queued`: a queued job whose commit disappeared cannot ever run.
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "cancelling"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** A job in one of these states holds (or is about to hold) its resources. */
export function isActive(status: JobStatus): boolean {
  return status === "running" || status === "cancelling";
}

const PHASE_TRANSITIONS: Readonly<Record<PhaseStatus, readonly PhaseStatus[]>> = {
  pending: ["running", "skipped", "cancelled"],
  running: ["running", "succeeded", "failed", "cancelled"], // running -> running: a repeated report is harmless
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export function canPhaseTransition(from: PhaseStatus, to: PhaseStatus): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export interface JobPhase {
  readonly position: number;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outcome: Outcome | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface Job {
  /** Arrival order; unique and increasing, unlike timestamps. */
  readonly seq: number;
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly ref: string;
  /** The commit pinned when the job was queued. */
  readonly sha: string;
  readonly target: string;
  readonly params: unknown;
  /** Resources the job needs, fixed when it was queued. */
  readonly locks: readonly string[];
  readonly retryOf: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  /** Root of the job's process tree, kept so a crashed service can clean it up. */
  readonly pid: number | null;
  readonly logPath: string | null;
  readonly reportPath: string | null;
  /** Already validated by whoever queued the job (https, allowlisted host); core only stores and forwards it. Null when none was given. */
  readonly webhookUrl: string | null;
  readonly phases: readonly JobPhase[];
}

export interface NewJob {
  readonly project: string;
  readonly kind: string;
  readonly ref: string;
  readonly sha: string;
  readonly target: string;
  readonly params: unknown;
  readonly locks: readonly string[];
  readonly phases: readonly string[];
  readonly retryOf?: string;
  readonly webhookUrl?: string;
}

export interface JobFilter {
  readonly project?: string;
  readonly ref?: string;
  readonly target?: string;
  readonly statuses?: readonly JobStatus[];
}

export interface JobPage {
  readonly limit?: number;
  /** Return jobs older than this `seq` (the `nextCursor` of the previous page). */
  readonly before?: number;
}

export interface JobList {
  readonly jobs: readonly Job[];
  readonly nextCursor: number | null;
}

/**
 * What may change when a job moves to a new status.
 *
 * Values are only ever added, never cleared: `outcome` and `error` keep what was recorded
 * first (the root cause), and paths set earlier survive a later move.
 */
export interface TransitionDetails {
  readonly outcome?: Outcome;
  readonly error?: string;
  readonly pid?: number | null;
  readonly logPath?: string;
  readonly reportPath?: string;
}

export interface PhaseUpdate {
  readonly status: PhaseStatus;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly outcome?: Outcome | null;
}

export class JobNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Job not found: ${id}`);
    this.name = "JobNotFoundError";
  }
}

/** A cancel (or other change) arrived for a job that already finished. */
export class JobAlreadyFinishedError extends Error {
  constructor(
    readonly id: string,
    readonly status: JobStatus,
  ) {
    super(`Job ${id} already finished (${status})`);
    this.name = "JobAlreadyFinishedError";
  }
}

/** The details given with a move do not fit the new status (e.g. `succeeded` without an outcome). */
export class InvalidDetailsError extends Error {
  constructor(
    readonly id: string,
    reason: string,
  ) {
    super(`Job ${id}: ${reason}`);
    this.name = "InvalidDetailsError";
  }
}

/** Phases and process ids only change while a job is running or being cancelled. */
export class JobNotActiveError extends Error {
  constructor(
    readonly id: string,
    readonly status: JobStatus,
  ) {
    super(`Job ${id} is ${status}, not running or cancelling`);
    this.name = "JobNotActiveError";
  }
}

export class InvalidPhaseTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly position: number,
    readonly from: PhaseStatus,
    readonly to: PhaseStatus,
  ) {
    super(`Job ${id} phase ${position} cannot go from ${from} to ${to}`);
    this.name = "InvalidPhaseTransitionError";
  }
}

/** Only a finished job can be retried; the retry points at a job that exists. */
export class RetryNotAllowedError extends Error {
  constructor(
    readonly id: string,
    readonly status: JobStatus | "missing",
  ) {
    super(`Job ${id} cannot be retried (${status})`);
    this.name = "RetryNotAllowedError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Job ${id} cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}
