import type { JobRequestInput, PhaseResult, PhaseRun, ProjectAdapter, RefPinner, RunContext, RunExecutor } from "../../src/core/adapter";
import { InvalidJobRequestError, RefNotFoundError } from "../../src/core/job-request";

interface Pending {
  readonly resolve: (result: PhaseResult) => void;
  readonly reject: (error: Error) => void;
  readonly context: RunContext;
}

export const OK: PhaseResult = { exitCode: 0, outcome: "success" };
export const FAIL: PhaseResult = { exitCode: 1, outcome: "failure" };
export const WARN: PhaseResult = { exitCode: 0, outcome: "warning" };

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lets in-flight promises run: the scheduler works across several awaits. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * An executor whose phases run until the test says how they end, and which records what the
 * scheduler asked of it.
 */
export class FakeExecutor implements RunExecutor {
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  readonly cleaned: Array<[string, number | null]> = [];
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly phaseNames: readonly string[] = ["scenario"]) {}

  plan(): readonly string[] {
    return this.phaseNames;
  }

  run(phase: PhaseRun, context: RunContext): Promise<PhaseResult> {
    const key = `${phase.job.id}:${phase.name}`;
    this.started.push(key);
    return new Promise<PhaseResult>((resolve, reject) => this.pending.set(key, { resolve, reject, context }));
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }

  async cleanup(jobId: string, leftoverPid: number | null): Promise<void> {
    this.cleaned.push([jobId, leftoverPid]);
  }

  /** The abort signal the scheduler gave to a running phase. */
  signalOf(jobId: string, phase = "scenario"): AbortSignal {
    const pending = this.pending.get(`${jobId}:${phase}`);
    if (!pending) throw new Error(`${jobId}:${phase} is not running`);
    return pending.context.signal;
  }

  isRunning(jobId: string, phase = "scenario"): boolean {
    return this.pending.has(`${jobId}:${phase}`);
  }

  /** Ends a running phase and lets the scheduler react. */
  async finish(jobId: string, result: PhaseResult, phase = "scenario"): Promise<void> {
    const pending = this.take(jobId, phase);
    pending.resolve(result);
    await settle();
  }

  async crash(jobId: string, message: string, phase = "scenario"): Promise<void> {
    this.take(jobId, phase).reject(new Error(message));
    await settle();
  }

  registerProcess(jobId: string, pid: number, phase = "scenario"): void {
    const pending = this.pending.get(`${jobId}:${phase}`);
    if (!pending) throw new Error(`${jobId}:${phase} is not running`);
    pending.context.registerProcess(pid);
  }

  private take(jobId: string, phase: string): Pending {
    const key = `${jobId}:${phase}`;
    const pending = this.pending.get(key);
    if (!pending) throw new Error(`${key} is not running`);
    this.pending.delete(key);
    return pending;
  }
}

/** Branch name -> commit. A branch that is not in the table does not exist. */
export class FakeRefs implements RefPinner {
  readonly pinned: string[] = [];
  readonly released: string[] = [];

  constructor(readonly commits: Record<string, string> = {}) {}

  async pin(ref: string): Promise<string> {
    const sha = this.commits[ref];
    if (!sha) throw new RefNotFoundError(ref);
    this.pinned.push(ref);
    return sha;
  }

  async release(sha: string): Promise<void> {
    this.released.push(sha);
  }
}

export const SHA_MAIN = "a".repeat(40);

export interface FakeAdapter extends ProjectAdapter {
  readonly executor: FakeExecutor;
  readonly refs: FakeRefs;
}

export function fakeAdapter(
  id: string,
  locks: readonly string[],
  executor: FakeExecutor = new FakeExecutor(),
  refs: FakeRefs = new FakeRefs({ main: SHA_MAIN, iteration_1: "b".repeat(40), "iteration_2": "c".repeat(40) }),
): FakeAdapter {
  return {
    id,
    locks,
    kinds: ["run", "build"],
    refs,
    executor,
    /** Accepts `{ retries: number }` only, like a strict adapter schema would. */
    validateRequest({ params }: JobRequestInput): unknown {
      if (params === null) return null;
      if (typeof params !== "object" || Array.isArray(params)) throw new InvalidJobRequestError("params must be an object");
      const entries = Object.entries(params as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (key !== "retries" || typeof value !== "number") throw new InvalidJobRequestError(`unknown or invalid parameter "${key}"`);
      }
      return params;
    },
  };
}
