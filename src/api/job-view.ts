import type { Job, JobPhase, JobStatus, Outcome, PhaseStatus } from "../core/job";

export interface PhaseView {
  readonly position: number;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outcome: Outcome | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** What the API shows of a job. Server-side paths and process ids stay inside. */
export interface JobView {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly ref: string;
  readonly sha: string;
  readonly target: string;
  readonly params: unknown;
  readonly locks: readonly string[];
  readonly retryOf: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  /** Name of the phase running now, if any. */
  readonly phase: string | null;
  readonly phases: readonly PhaseView[];
  /** Beyond "something else is using its resource": e.g. a Detox job waiting on a disconnected device. */
  readonly waitingReason: string | null;
}

function toPhaseView(phase: JobPhase): PhaseView {
  return {
    position: phase.position,
    name: phase.name,
    status: phase.status,
    exitCode: phase.exitCode,
    signal: phase.signal,
    outcome: phase.outcome,
    startedAt: phase.startedAt,
    finishedAt: phase.finishedAt,
  };
}

export function toJobView(job: Job, waitingReason?: string): JobView {
  return {
    id: job.id,
    project: job.project,
    kind: job.kind,
    status: job.status,
    ref: job.ref,
    sha: job.sha,
    target: job.target,
    params: job.params,
    locks: job.locks,
    retryOf: job.retryOf,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    outcome: job.outcome,
    error: job.error,
    phase: job.phases.find((phase) => phase.status === "running")?.name ?? null,
    phases: job.phases.map(toPhaseView),
    waitingReason: waitingReason ?? null,
  };
}
