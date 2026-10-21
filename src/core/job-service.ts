import { CatalogUnsupportedError, UnknownProjectError, type AdapterLookup, type ProjectCatalog } from "./adapter";
import { isBranchAllowed } from "./branch-pattern";
import { JobNotFoundError, type Job, type JobFilter, type JobList, type JobPage } from "./job";
import type { JobEnqueuer } from "./job-enqueuer";
import { COMMIT_SHA, InvalidJobRequestError, RefNotAllowedError, TARGET_NAME } from "./job-request";
import type { JobStore } from "./job-store";

export const JOB_SERVICE = Symbol("JOB_SERVICE");

/** What the service enforces for a project, whatever its adapter does. */
export interface ProjectPolicy {
  readonly id: string;
  readonly allowedBranches: readonly string[];
  readonly defaultBranch: string;
}

/** Cancels a job; the scheduler does it. */
export interface JobCanceller {
  cancel(id: string): Promise<Job>;
}

export interface SubmitJob {
  readonly project: string;
  /** Defaults to the project's default branch. */
  readonly ref?: string;
  /** Defaults to the adapter's first kind. */
  readonly kind?: string;
  readonly target: string;
  readonly params?: unknown;
}

function hasParentSegment(target: string): boolean {
  return target.split("/").includes("..");
}

/**
 * The use cases of the jobs API. It decides who may queue what (project, branch, kind, target
 * name); the adapter then checks what only it can know, and the commit is pinned before the job exists.
 */
export class JobService {
  private readonly policies: ReadonlyMap<string, ProjectPolicy>;

  constructor(
    policies: readonly ProjectPolicy[],
    private readonly adapters: AdapterLookup,
    private readonly enqueuer: JobEnqueuer,
    private readonly canceller: JobCanceller,
    private readonly store: JobStore,
  ) {
    this.policies = new Map(policies.map((policy) => [policy.id, policy]));
  }

  async submit(input: SubmitJob): Promise<Job> {
    const policy = this.policies.get(input.project);
    if (!policy) throw new UnknownProjectError(input.project);
    const adapter = this.adapters.get(input.project);

    const ref = input.ref ?? policy.defaultBranch;
    if (!isBranchAllowed(policy.allowedBranches, ref)) throw new RefNotAllowedError(ref);

    const kind = input.kind ?? adapter.kinds[0];
    if (kind === undefined || !adapter.kinds.includes(kind)) {
      throw new InvalidJobRequestError(`kind must be one of: ${adapter.kinds.join(", ")}`);
    }
    if (!TARGET_NAME.test(input.target) || hasParentSegment(input.target)) throw new InvalidJobRequestError("target is not a valid scenario name");
    const params = adapter.validateRequest({ kind, target: input.target, params: input.params ?? null });

    const sha = await adapter.refs.pin(ref);
    try {
      if (!COMMIT_SHA.test(sha)) throw new Error(`The adapter for "${input.project}" returned an invalid commit`);
      return this.enqueuer.enqueue({ project: input.project, kind, ref, sha, target: input.target, params });
    } catch (error) {
      // Nothing was queued: do not leave the commit protected for a job that does not exist.
      await adapter.refs.release(sha).catch(() => undefined);
      throw error;
    }
  }

  get(id: string): Job {
    const job = this.store.get(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  list(filter?: JobFilter, page?: JobPage): JobList {
    return this.store.list(filter, page);
  }

  cancel(id: string): Promise<Job> {
    return this.canceller.cancel(id);
  }

  /**
   * Queues a new job with the original's project, kind, branch, target and parameters, pointed at the
   * exact same commit (never re-pinned: a retry proves nothing about the branch's tip today). Only a
   * finished job may be retried; `get` gives the clearer JobNotFoundError for a missing one, and the
   * store's own `assertRetryable` (shared with every other caller of `create`) is the single place that
   * enforces "finished", so that rule can never drift between the two.
   */
  retry(id: string): Job {
    const original = this.get(id);
    return this.enqueuer.enqueue({
      project: original.project,
      kind: original.kind,
      ref: original.ref,
      sha: original.sha,
      target: original.target,
      params: original.params,
      retryOf: id,
    });
  }

  projects(): readonly ProjectPolicy[] {
    return [...this.policies.values()];
  }

  /** The project's catalog, for browsing branches and what can be queued on one. Throws UnknownProjectError or CatalogUnsupportedError. */
  catalogOf(id: string): ProjectCatalog {
    if (!this.policies.has(id)) throw new UnknownProjectError(id);
    const browsable = this.adapters.get(id).browsable;
    if (!browsable) throw new CatalogUnsupportedError(id);
    return browsable;
  }
}
