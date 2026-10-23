import type { AdapterLookup, PhaseResult, ProjectAdapter, Readiness, RunContext, RunExecutor } from "./adapter";
import { silentDiagnostics, type Diagnostics } from "./diagnostics";
import { JobAlreadyFinishedError, JobNotFoundError, isTerminal, type Job, type JobPhase } from "./job";
import type { JobStore } from "./job-store";
import type { QueueListener } from "./queue-listener";

export const DEFAULT_CANCEL_GRACE_MS = 30_000;

export interface SchedulerOptions {
  /** Longest a single phase may run. Unset: no limit (a Detox build can legitimately take long). */
  readonly phaseTimeoutMs?: number;
  /** How long a stopping phase gets to end before the scheduler abandons it and cleans up. */
  readonly cancelGraceMs?: number;
  /**
   * How often to re-check queued jobs an adapter's `canStart` is blocking (e.g. on a device that is not
   * connected yet) — nothing else wakes the scheduler up for them, since their own resource lock never
   * changes and no other job's completion frees anything they are waiting on. Unset: no periodic
   * re-check (only new submissions and other jobs finishing call `kick()`).
   */
  readonly recheckIntervalMs?: number;
  /**
   * Longest an adapter's `canStart` may take before it is treated the same as a throw: ready, logged,
   * and moved on from. `canStart` can share a lock with other catalog operations (`fetch`/`browse`,
   * Detox's own `withBrowseLock`) that has no timeout of its own, so a stuck one of those would
   * otherwise hang every future `canStart` queued behind the same lock forever — worse than before
   * this gate existed, since the job would not even get the chance to start-then-fail visibly.
   */
  readonly canStartTimeoutMs?: number;
}

export const DEFAULT_CAN_START_TIMEOUT_MS = 5_000;

/** What the scheduler holds about a job that is running right now. */
interface LiveRun {
  readonly abort: AbortController;
  readonly timers: Set<NodeJS.Timeout>;
  /** Ends the current phase with this result, whether or not the adapter ever returns. */
  force: (result: PhaseResult) => void;
  timeoutReason: string | undefined;
}

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
  private readonly live = new Map<string, LiveRun>();
  private readonly warnedProjects = new Set<string>();
  private readonly cancelGraceMs: number;
  private readonly phaseTimeoutMs: number | undefined;
  private readonly canStartTimeoutMs: number;
  /** Why a queued job's own `canStart` check last said it was not ready; cleared the moment it is. */
  private readonly waitingReasons = new Map<string, string>();
  private readonly recheckTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly adapters: AdapterLookup,
    private readonly diagnostics: Diagnostics = silentDiagnostics,
    options: SchedulerOptions = {},
  ) {
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.phaseTimeoutMs = options.phaseTimeoutMs;
    this.canStartTimeoutMs = options.canStartTimeoutMs ?? DEFAULT_CAN_START_TIMEOUT_MS;
    if (options.recheckIntervalMs) {
      this.recheckTimer = setInterval(() => this.kick(), options.recheckIntervalMs);
      this.recheckTimer.unref();
    }
  }

  /** The reason a queued job is not starting beyond "something else is using its resource", if any. */
  waitingReasonFor(jobId: string): string | undefined {
    return this.waitingReasons.get(jobId);
  }

  /**
   * Starts every queued job that can start now. Never throws: a problem with one job cannot stop the
   * others. `startWhatFits` is async (an adapter's `canStart` may do real I/O) but its body still runs
   * synchronously up to its first real `await` — which, for every job whose adapter has no `canStart`
   * (everything before this session, and still most jobs after it), is never reached at all, so claiming
   * and starting such a job happens before `kick()` returns, exactly as before. Two overlapping passes
   * (a slow `canStart` straddling another `kick()`) are safe without any extra guard: `JobStore.claim`
   * is its own SQLite transaction, so either pass's claim on a given job simply loses the race and backs
   * off, the same way two passes already could race today on an ordinary lock.
   */
  kick(): void {
    if (this.stopped) return;
    this.startWhatFits().catch((error: unknown) => {
      this.diagnostics.error({ error: describeError(error) }, "could not read the queue");
    });
  }

  /** Stops starting jobs. Jobs already running are left alone; see `shutdown` to stop them too. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.recheckTimer);
  }

  /** Resolves when every job started so far has reached a final status. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Graceful shutdown: no new jobs start, running ones are cancelled (so they end `cancelled`, not
   * orphaned) and we wait up to `timeoutMs` for them. Whatever is left is reconciled on the next start.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.stop();
    await Promise.all(
      [...this.inFlight.keys()].map((id) =>
        this.cancel(id).catch((error: unknown) => this.diagnostics.warn({ job: id, error: describeError(error) }, "could not cancel at shutdown")),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    try {
      await Promise.race([this.idle(), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * After a crash: jobs left running or cancelling have no process behind them. The adapter cleans
   * what they left (including a process tree that outlived the service), then they are finished,
   * which also frees their resources. Queued jobs are kept. Jobs this scheduler is running right now
   * are not orphans and are skipped, so calling this late is harmless.
   */
  async reconcile(): Promise<void> {
    for (const job of this.store.listActive()) {
      if (this.inFlight.has(job.id)) continue;
      try {
        await this.closeOrphan(job);
      } catch (error) {
        this.diagnostics.error({ job: job.id, error: describeError(error) }, "could not close an orphaned job");
      }
    }
    this.kick();
  }

  /**
   * Cancels a job: a queued one is removed from the queue; a running one is asked to stop and ends
   * as `cancelled`. Cancelling a job that is already being cancelled succeeds (idempotent); one that
   * already finished throws JobAlreadyFinishedError.
   */
  async cancel(id: string): Promise<Job> {
    const job = this.store.get(id);
    if (!job) throw new JobNotFoundError(id);
    if (job.status === "cancelling") return job;
    if (isTerminal(job.status)) throw new JobAlreadyFinishedError(id, job.status);

    if (job.status === "queued") {
      const cancelled = this.store.transition(id, "cancelled");
      this.waitingReasons.delete(id);
      this.kick(); // jobs queued behind this one may have been waiting only for it
      return cancelled;
    }
    const cancelling = this.store.transition(id, "cancelling");
    await this.stopRun(job, undefined);
    return cancelling;
  }

  // -- starting --

  private async startWhatFits(): Promise<void> {
    const waitingFor = new Set<string>();
    for (const job of this.store.listByStatus("queued")) {
      const adapter = this.adapters.find(job.project);
      if (!adapter) {
        // Kept, not failed: the project may be missing from this start's configuration only.
        this.warnMissingAdapter(job);
        continue;
      }
      if (job.locks.some((resource) => waitingFor.has(resource))) {
        job.locks.forEach((resource) => waitingFor.add(resource));
        continue;
      }
      if (adapter.canStart) {
        const readiness = await this.safelyCheck(adapter, job);
        // Only record a reason if the job is still actually queued: `canStart` awaited a real check,
        // during which an overlapping pass (another kick(), e.g. the recheck timer) could already have
        // claimed and started — or even finished — this same job. Writing a stale reason over that would
        // leave `waitingReasonFor` permanently wrong for a job that is no longer waiting on anything.
        if (!readiness.ready && this.store.get(job.id)?.status === "queued") {
          this.waitingReasons.set(job.id, readiness.reason);
          job.locks.forEach((resource) => waitingFor.add(resource));
          continue;
        }
        if (!readiness.ready) continue; // not queued any more: nothing to wait for, nothing to lock behind
      }
      this.waitingReasons.delete(job.id);
      let running: Job | undefined;
      try {
        running = this.store.claim(job.id);
      } catch (error) {
        this.failQueued(job, `Could not start: ${describeError(error)}`);
        continue;
      }
      if (running) this.start(running, adapter);
      else job.locks.forEach((resource) => waitingFor.add(resource));
    }
  }

  private start(job: Job, adapter: ProjectAdapter): void {
    const live: LiveRun = { abort: new AbortController(), timers: new Set(), force: () => undefined, timeoutReason: undefined };
    this.live.set(job.id, live);
    const run = this.execute(job, adapter.executor, live)
      .catch((error: unknown) => this.diagnostics.error({ job: job.id, error: describeError(error) }, "job execution crashed"))
      .finally(() => {
        this.clearTimers(live);
        this.live.delete(job.id);
        this.inFlight.delete(job.id);
        this.kick();
      });
    this.inFlight.set(job.id, run);
  }

  // -- running --

  private async execute(job: Job, executor: RunExecutor, live: LiveRun): Promise<void> {
    const context: RunContext = {
      signal: live.abort.signal,
      registerProcess: (pid) => this.safely(job.id, "record the process id", () => this.store.setPid(job.id, pid)),
    };

    let failure: string | undefined;
    let warned = false;
    let reportPath: string | undefined;
    try {
      for (const phase of job.phases) {
        if (this.store.get(job.id)?.status === "cancelling") break;
        this.store.updatePhase(job.id, phase.position, { status: "running" });
        const result = await this.runPhase(executor, job, phase, context, live);
        // The phase's processes are gone: a pid left behind could point at an unrelated process after a restart.
        this.safely(job.id, "clear the process id", () => this.store.setPid(job.id, null));
        this.store.updatePhase(job.id, phase.position, {
          status: result.outcome === "failure" ? "failed" : "succeeded",
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          outcome: result.outcome,
        });
        reportPath = result.reportPath ?? reportPath;
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
    this.finish(job.id, failure, warned, reportPath);
  }

  /** Runs one phase, ending it early if the adapter throws, the phase times out, or a cancel is ignored. */
  private async runPhase(executor: RunExecutor, job: Job, phase: JobPhase, context: RunContext, live: LiveRun): Promise<PhaseResult> {
    const forced = new Promise<PhaseResult>((resolve) => (live.force = resolve));
    if (this.phaseTimeoutMs !== undefined) {
      const reason = `Phase "${phase.name}" timed out after ${this.phaseTimeoutMs} ms`;
      this.arm(live, this.phaseTimeoutMs, () => void this.stopRun(job, reason));
    }
    const actual = (async (): Promise<PhaseResult> => {
      try {
        return await executor.run({ job, position: phase.position, name: phase.name }, context);
      } catch (error) {
        return { exitCode: null, outcome: "failure", error: `Phase "${phase.name}" crashed: ${describeError(error)}` };
      }
    })();
    try {
      const result = await Promise.race([actual, forced]);
      return live.timeoutReason === undefined ? result : { ...result, outcome: "failure", error: live.timeoutReason };
    } finally {
      this.clearTimers(live);
    }
  }

  /**
   * Asks a run to stop: aborts its signal, tells the adapter to kill its processes, and starts the
   * clock after which the phase is abandoned if it still has not ended.
   */
  private async stopRun(job: Job, timeoutReason: string | undefined): Promise<void> {
    const live = this.live.get(job.id);
    if (live) {
      if (timeoutReason !== undefined) live.timeoutReason = timeoutReason;
      live.abort.abort();
      this.arm(live, this.cancelGraceMs, () =>
        live.force({
          exitCode: null,
          outcome: "failure",
          error: timeoutReason ?? `The phase did not stop within ${this.cancelGraceMs} ms of the cancel and was abandoned`,
        }),
      );
    }
    try {
      await this.adapters.find(job.project)?.executor.cancel(job.id);
    } catch (error) {
      this.diagnostics.error({ job: job.id, error: describeError(error) }, "the adapter could not stop the job");
    }
  }

  private arm(live: LiveRun, ms: number, action: () => void): void {
    const timer = setTimeout(action, ms);
    timer.unref();
    live.timers.add(timer);
  }

  private clearTimers(live: LiveRun): void {
    live.timers.forEach(clearTimeout);
    live.timers.clear();
  }

  private async cleanUp(executor: RunExecutor, id: string): Promise<void> {
    try {
      await executor.cleanup(id, null);
    } catch (error) {
      this.diagnostics.error({ job: id, error: describeError(error) }, "cleanup failed");
    }
  }

  /** Records the final status. If that is refused, still get the job out of `running`, or it would hold its resources forever. */
  private finish(id: string, failure: string | undefined, warned: boolean, reportPath: string | undefined): void {
    const report = reportPath === undefined ? {} : { reportPath };
    try {
      if (this.store.get(id)?.status === "cancelling") this.store.transition(id, "cancelled", report);
      else if (failure !== undefined) this.store.transition(id, "failed", { error: failure, ...report });
      else this.store.transition(id, "succeeded", { outcome: warned ? "warning" : "success", ...report });
      return;
    } catch (error) {
      this.diagnostics.error({ job: id, error: describeError(error) }, "could not record the final status");
      this.safely(id, "force the final status", () => {
        const status = this.store.get(id)?.status;
        if (status === "cancelling") this.store.transition(id, "cancelled");
        else if (status === "running") this.store.transition(id, "failed", { error: `Could not record the final status: ${describeError(error)}` });
      });
    }
  }

  // -- recovery and bookkeeping --

  private async closeOrphan(job: Job): Promise<void> {
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
    this.diagnostics.warn({ job: job.id, was: job.status, pid: job.pid, cleaned: adapter !== undefined }, "orphaned job closed after a restart");
  }

  private warnMissingAdapter(job: Job): void {
    if (this.warnedProjects.has(job.project)) return;
    this.warnedProjects.add(job.project);
    this.diagnostics.warn({ project: job.project, job: job.id }, "queued jobs of a project without an adapter are waiting");
  }

  private failQueued(job: Job, error: string): void {
    this.waitingReasons.delete(job.id);
    this.safely(job.id, "fail a queued job", () => this.store.transition(job.id, "failed", { error }));
  }

  private safely(id: string, what: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.diagnostics.warn({ job: id, error: describeError(error) }, `could not ${what}`);
    }
  }

  /**
   * An adapter's `canStart` failing is never a reason to leave a job queued forever: the gate is an
   * optimization (do not even attempt a job that is obviously missing a resource), not the safety check
   * that actually running the job already does on its own. Fails open.
   */
  private async safelyCheck(adapter: ProjectAdapter, job: Job): Promise<Readiness> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Readiness>((resolve) => {
      timer = setTimeout(() => {
        this.diagnostics.warn({ job: job.id, timeoutMs: this.canStartTimeoutMs }, "canStart took too long to answer; starting the job anyway");
        resolve({ ready: true });
      }, this.canStartTimeoutMs);
      timer.unref();
    });
    try {
      // The real check keeps running even after the race is decided by the timeout (nothing here can
      // cancel it, e.g. a shared lock with no timeout of its own) — harmless: by the time it resolves,
      // nothing is still awaiting it, so a late `{ ready: false }` has nowhere to be (wrongly) recorded.
      return await Promise.race([adapter.canStart!(job), timeout]);
    } catch (error) {
      this.diagnostics.warn({ job: job.id, error: describeError(error) }, "could not check whether the job's resources are ready; starting it anyway");
      return { ready: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
