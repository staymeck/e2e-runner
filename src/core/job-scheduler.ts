import type { AdapterLookup, PhaseResult, ProjectAdapter, RunContext, RunExecutor } from "./adapter";
import { silentDiagnostics, type Diagnostics } from "./diagnostics";
import type { QueueListener } from "./job-enqueuer";
import {
  InvalidTransitionError,
  JobAlreadyFinishedError,
  JobNotFoundError,
  isTerminal,
  type Job,
  type JobPhase,
} from "./job";
import type { JobStore } from "./job-store";

const MAX_CANCEL_ATTEMPTS = 3;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts queued jobs when their resources are free and drives them to a final status.
 *
 * Order is first come, first served *per resource*: a job waiting for `devices` does not hold
 * back a later job that needs something else, but no later job may take a resource an earlier
 * waiting job needs (that could starve it).
 */
export class JobScheduler implements QueueListener {
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly adapters: AdapterLookup,
    private readonly diagnostics: Diagnostics = silentDiagnostics,
  ) {}

  /** Starts every queued job that can start now. Synchronous: the queue is decided in one pass. */
  kick(): void {
    if (this.stopped) return;
    const waitingFor = new Set<string>();
    for (const job of this.store.listByStatus("queued")) {
      const adapter = this.adapters.find(job.project);
      if (!adapter) {
        this.failQueued(job, `No adapter for project "${job.project}"`);
        continue;
      }
      if (job.locks.some((resource) => waitingFor.has(resource))) {
        job.locks.forEach((resource) => waitingFor.add(resource));
        continue;
      }
      const running = this.store.claim(job.id);
      if (running) this.start(running, adapter);
      else job.locks.forEach((resource) => waitingFor.add(resource));
    }
  }

  /** Stops starting jobs. Jobs already running are left alone; the next start reconciles them. */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves when every job started so far has reached a final status. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * After a crash: jobs left running or cancelling have no process behind them. The adapter cleans
   * what they left (including a process tree that outlived the service), then they are finished,
   * which also frees their resources. Queued jobs are kept.
   */
  async reconcile(): Promise<void> {
    for (const job of this.store.listActive()) {
      const adapter = this.adapters.find(job.project);
      if (adapter) {
        try {
          await adapter.executor.cleanup(job.id, job.pid);
        } catch (error) {
          this.diagnostics.error({ job: job.id, error: describeError(error) }, "cleanup of an orphaned job failed");
        }
      }
      const phase = job.phases.find((candidate) => candidate.status === "running");
      const where = phase ? `phase "${phase.name}"` : "preparation";
      if (job.status === "cancelling") this.store.transition(job.id, "cancelled");
      else this.store.transition(job.id, "failed", { error: `Service restarted during ${where}` });
      this.diagnostics.warn({ job: job.id, status: job.status }, "orphaned job closed after a restart");
    }
    this.kick();
  }

  /**
   * Cancels a job: a queued one is removed from the queue; a running one is asked to stop and ends
   * as `cancelled`. Cancelling a job that is already being cancelled succeeds (idempotent); one that
   * already finished throws JobAlreadyFinishedError.
   */
  async cancel(id: string): Promise<Job> {
    let lastRace: unknown;
    for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt++) {
      const job = this.store.get(id);
      if (!job) throw new JobNotFoundError(id);
      if (job.status === "cancelling") return job;
      if (isTerminal(job.status)) throw new JobAlreadyFinishedError(id, job.status);
      try {
        if (job.status === "queued") return this.store.transition(id, "cancelled");
        const cancelling = this.store.transition(id, "cancelling");
        await this.requestStop(job);
        return cancelling;
      } catch (error) {
        if (!(error instanceof InvalidTransitionError)) throw error;
        lastRace = error; // the job moved between the read and the write: look again
      }
    }
    throw lastRace;
  }

  private start(job: Job, adapter: ProjectAdapter): void {
    const run = this.execute(job, adapter.executor)
      .catch((error: unknown) => this.diagnostics.error({ job: job.id, error: describeError(error) }, "job execution crashed"))
      .finally(() => {
        this.inFlight.delete(job.id);
        this.kick();
      });
    this.inFlight.set(job.id, run);
  }

  private async execute(job: Job, executor: RunExecutor): Promise<void> {
    const context: RunContext = {
      registerProcess: (pid) => {
        try {
          this.store.setPid(job.id, pid);
        } catch (error) {
          this.diagnostics.warn({ job: job.id, error: describeError(error) }, "could not record the process id");
        }
      },
    };

    let failure: string | undefined;
    let warned = false;
    try {
      for (const phase of job.phases) {
        if (this.store.get(job.id)?.status === "cancelling") break;
        this.store.updatePhase(job.id, phase.position, { status: "running" });
        const result = await this.runPhase(executor, job, phase, context);
        this.store.updatePhase(job.id, phase.position, {
          status: result.outcome === "failure" ? "failed" : "succeeded",
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          outcome: result.outcome,
        });
        if (result.outcome === "failure") {
          failure = result.error ?? `Phase "${phase.name}" failed (exit code ${result.exitCode ?? "none"})`;
          break;
        }
        if (result.outcome === "warning") warned = true;
      }
    } catch (error) {
      failure = `Internal error: ${describeError(error)}`;
    } finally {
      // Before the resources are released: the next job must not start on top of leftovers.
      await this.cleanUp(executor, job.id);
    }
    this.finish(job.id, failure, warned);
  }

  private async runPhase(executor: RunExecutor, job: Job, phase: JobPhase, context: RunContext): Promise<PhaseResult> {
    try {
      return await executor.run({ job, position: phase.position, name: phase.name }, context);
    } catch (error) {
      return { exitCode: null, outcome: "failure", error: `Phase "${phase.name}" crashed: ${describeError(error)}` };
    }
  }

  private async cleanUp(executor: RunExecutor, id: string): Promise<void> {
    try {
      await executor.cleanup(id, null);
    } catch (error) {
      this.diagnostics.error({ job: id, error: describeError(error) }, "cleanup failed");
    }
  }

  private finish(id: string, failure: string | undefined, warned: boolean): void {
    try {
      if (this.store.get(id)?.status === "cancelling") this.store.transition(id, "cancelled");
      else if (failure !== undefined) this.store.transition(id, "failed", { error: failure });
      else this.store.transition(id, "succeeded", { outcome: warned ? "warning" : "success" });
    } catch (error) {
      this.diagnostics.error({ job: id, error: describeError(error) }, "could not record the final status");
    }
  }

  private failQueued(job: Job, error: string): void {
    try {
      this.store.transition(job.id, "failed", { error });
    } catch (problem) {
      this.diagnostics.error({ job: job.id, error: describeError(problem) }, "could not fail a queued job");
    }
  }

  private async requestStop(job: Job): Promise<void> {
    try {
      await this.adapters.find(job.project)?.executor.cancel(job.id);
    } catch (error) {
      this.diagnostics.error({ job: job.id, error: describeError(error) }, "the adapter could not stop the job");
    }
  }
}
