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
  /** Where the phase left its report on the server; the last one a job reports is kept on the job. */
  readonly reportPath?: string;
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

/** Turns a branch name into the commit a job will run, so what was seen when queueing is what runs. */
export interface RefPinner {
  /**
   * Resolves an already-allowed branch to its commit (40 hex characters) and keeps that commit from
   * being garbage collected while jobs may still need it. Throws RefNotFoundError if it does not exist.
   */
  pin(ref: string): Promise<string>;
  /** Undoes a `pin` whose job was never created. Idempotent; must not throw for an unknown commit. */
  release(sha: string): Promise<void>;
}

export interface JobRequestInput {
  readonly kind: string;
  readonly target: string;
  readonly params: unknown;
}

/** What a catalog offers about one thing a job can be queued for (a scenario, a build target, ...). */
export interface CatalogTarget {
  readonly id: string;
  readonly title: string | null;
}

/**
 * Lets a client browse a project's catalog before queueing a job: which branches exist, and what can be
 * run on the one currently browsed. `browse` and `targets` are a pair: `targets` always answers for
 * whatever `browse` last positioned the catalog at, the way the service's one browsing folder works.
 */
export interface ProjectCatalog {
  /** Brings new branches from the remote. */
  fetch(): Promise<void>;
  /** Remote branches this project allows. */
  refs(): Promise<readonly string[]>;
  /** Positions the catalog's browsing folder on this branch's commit. Throws RefNotAllowedError or RefNotFoundError. */
  browse(ref: string): Promise<{ readonly sha: string }>;
  /** What can be queued on whatever `browse` last positioned the catalog at. Throws InvalidJobRequestError if nothing was browsed yet. */
  targets(): Promise<readonly CatalogTarget[]>;
}

/** adb's own three states, as the catalog's `devices --json` contract reports them. */
export interface DeviceStatus {
  readonly name: string;
  readonly state: "connected" | "disconnected" | "unauthorized";
}

/** Lets a client see what the project's physical devices look like right now, before queueing a job. */
export interface DeviceChecker {
  list(): Promise<readonly DeviceStatus[]>;
}

export type Readiness = { readonly ready: true } | { readonly ready: false; readonly reason: string };

export interface ProjectAdapter {
  readonly id: string;
  /** Resources every job of this project needs exclusively (e.g. `devices`). */
  readonly locks: readonly string[];
  /** Kinds of job it can run; the first one is the default. */
  readonly kinds: readonly string[];
  readonly refs: RefPinner;
  readonly executor: RunExecutor;
  /**
   * Browsing a catalog ahead of queueing a job (branches, then what can be queued on one). Optional for a
   * future adapter that cannot offer it (e.g. an early Cucumber adapter); every adapter has it today.
   */
  readonly browsable?: ProjectCatalog;
  /** Lets a client see the project's device status. Optional: only a project with physical devices has one. */
  readonly devices?: DeviceChecker;
  /**
   * Whether this job's resources are actually usable right now, beyond the scheduler's own lock
   * bookkeeping (a free `devices` lock only means no other job is running — not that the devices this
   * particular job needs are connected). Optional: an adapter with nothing further to check (or a job
   * kind that does not have per-job resource needs) is always ready, the scheduler's default.
   */
  canStart?(job: Job): Promise<Readiness>;
  /**
   * The project's own check of a request, with a strict schema (unknown keys rejected). Returns the
   * parameters to store. Throws InvalidJobRequestError.
   */
  validateRequest(request: JobRequestInput): unknown;
}

export class CatalogUnsupportedError extends Error {
  constructor(readonly project: string) {
    super(`Project "${project}" has no browsable catalog`);
    this.name = "CatalogUnsupportedError";
  }
}

export class ProjectHasNoDevicesError extends Error {
  constructor(readonly project: string) {
    super(`Project "${project}" has no devices to report on`);
    this.name = "ProjectHasNoDevicesError";
  }
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
