import type { AdapterLookup } from "./adapter";
import type { Job } from "./job";
import type { JobStore } from "./job-store";
import type { QueueListener } from "./queue-listener";

export interface EnqueueRequest {
  readonly project: string;
  readonly kind: string;
  readonly ref: string;
  /** The commit pinned for this job; the caller resolves it before enqueuing. */
  readonly sha: string;
  readonly target: string;
  readonly params?: unknown;
  readonly retryOf?: string;
  readonly webhookUrl?: string;
}

/**
 * Turns a request into a queued job. The resources and phases come from the project's adapter,
 * never from the caller, and are fixed here: a retry or a later configuration change cannot alter them.
 */
export class JobEnqueuer {
  constructor(
    private readonly store: JobStore,
    private readonly adapters: AdapterLookup,
    private readonly listener: QueueListener,
  ) {}

  enqueue(request: EnqueueRequest): Job {
    const adapter = this.adapters.get(request.project);
    const job = this.store.create({
      project: request.project,
      kind: request.kind,
      ref: request.ref,
      sha: request.sha,
      target: request.target,
      params: request.params,
      locks: [...new Set(adapter.locks)],
      phases: [...adapter.executor.plan({ kind: request.kind, target: request.target, params: request.params })],
      ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
      ...(request.webhookUrl === undefined ? {} : { webhookUrl: request.webhookUrl }),
    });
    this.listener.kick();
    // The queue may have started it already: return what is true now, not the snapshot from creation.
    return this.store.get(job.id) ?? job;
  }
}
