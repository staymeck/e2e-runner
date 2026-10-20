import type { Job, Outcome } from "./job";

/** One phase of a job about to run (e.g. `build`, then `scenario`). */
export interface PhaseRun {
  readonly job: Job;
  readonly position: number;
  readonly name: string;
}

export interface PhaseResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  /** `failure` stops the job; `warning` and `success` let it continue. */
  readonly outcome: Outcome;
  readonly error?: string;
}

export interface RunContext {
  /** Tells the service the root of the process tree it just started, so a crash can be cleaned up after. */
  registerProcess(pid: number): void;
  /**
   * Aborted when the job is cancelled or the phase times out. Unlike `RunExecutor.cancel`, it cannot be
   * missed: an adapter that is still setting up when the cancel arrives sees `aborted` and must not start.
   */
  readonly signal: AbortSignal;
}

/** Runs the phases of a job. The only part of an adapter the scheduler needs. */
export interface RunExecutor {
  /** Names of the phases a job of this kind goes through, in order. */
  plan(request: { readonly kind: string; readonly target: string; readonly params: unknown }): readonly string[];
  /**
   * Runs one phase to the end. Must resolve (with outcome `failure`) rather than throw for an ordinary
   * failure, and should stop when `context.signal` aborts. The scheduler does not wait forever: after a
   * cancel (grace period) or a timeout it gives up on the phase and cleans up, so a run that ignores
   * both is abandoned, not trusted.
   */
  run(phase: PhaseRun, context: RunContext): Promise<PhaseResult>;
  /** Kills the running phase's processes. Idempotent; safe to call when nothing is running. */
  cancel(jobId: string): Promise<void>;
  /**
   * Removes whatever the job left behind. Called after every run and, after a crash, with the
   * process id the dead service had registered. Idempotent; must not throw.
   */
  cleanup(jobId: string, leftoverPid: number | null): Promise<void>;
}

export interface ProjectAdapter {
  readonly id: string;
  /** Resources every job of this project needs exclusively (e.g. `devices`). */
  readonly locks: readonly string[];
  readonly executor: RunExecutor;
}

export class UnknownProjectError extends Error {
  constructor(readonly project: string) {
    super(`Unknown project: ${project}`);
    this.name = "UnknownProjectError";
  }
}

export interface AdapterLookup {
  get(project: string): ProjectAdapter;
  find(project: string): ProjectAdapter | undefined;
}

export class AdapterRegistry implements AdapterLookup {
  private readonly adapters = new Map<string, ProjectAdapter>();

  constructor(adapters: readonly ProjectAdapter[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: ProjectAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  find(project: string): ProjectAdapter | undefined {
    return this.adapters.get(project);
  }

  get(project: string): ProjectAdapter {
    const adapter = this.find(project);
    if (!adapter) throw new UnknownProjectError(project);
    return adapter;
  }
}
