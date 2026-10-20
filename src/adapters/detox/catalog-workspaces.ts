import * as fs from "node:fs";
import * as path from "node:path";
import type { RefPinner } from "../../core/adapter";
import { isBranchAllowed, isValidBranchName } from "../../core/branch-pattern";
import { COMMIT_SHA, RefNotAllowedError, RefNotFoundError } from "../../core/job-request";
import { Mutex } from "../../core/mutex";
import type { DependencyInstaller } from "./dependency-installer";
import type { GitRepo } from "./git-repo";

/** The file that marks a folder as a catalog the orchestrator can run. */
export const CATALOG_MARKER = "orch.rc.json";

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** A job asks to run a commit that was never pinned by this service (or whose pin was released). */
export class CommitUnavailableError extends Error {
  constructor(readonly sha: string) {
    super(`Commit ${sha} is not pinned: it was not queued through this service, or its pin was released`);
    this.name = "CommitUnavailableError";
  }
}

export interface Workspace {
  readonly dir: string;
  readonly sha: string;
}

/**
 * The catalog `detox-testing` seen through its two fixed folders. A folder to browse a branch in, and a
 * folder to run one commit in: callers never learn which they are, so a folder per commit can replace
 * this later without changing them.
 */
export interface CatalogWorkspaces extends RefPinner {
  fetch(): Promise<void>;
  /** Remote branches this project allows. */
  refs(): Promise<string[]>;
  /** Positions the browsing folder on the branch's commit. Never touches the run folder. */
  browse(ref: string): Promise<Workspace>;
  /**
   * Positions the run folder on exactly this (pinned) commit and installs its dependencies. It force-checks-out
   * and cleans the folder, so it must only be called between jobs: the one caller is the Detox executor, which
   * the scheduler runs one job at a time (the `devices` resource).
   */
  prepareRun(sha: string): Promise<Workspace>;
  /** Forgets every pinned commit not in `keep`. Returns how many were released. */
  prunePins(keep: ReadonlySet<string>): Promise<number>;
}

/**
 * Both folders are worktrees of one repository, so one `fetch` serves both and a pinned commit is
 * visible to both. Every git operation goes through one mutex: they share refs and packed objects and
 * would otherwise contend for git's lock files.
 */
export class GitCatalogWorkspaces implements CatalogWorkspaces {
  private readonly git = new Mutex();
  private readonly runFolder = new Mutex();

  constructor(
    private readonly runRepo: GitRepo,
    private readonly browseRepo: GitRepo,
    private readonly allowedBranches: readonly string[],
    private readonly installer: DependencyInstaller,
  ) {}

  fetch(): Promise<void> {
    return this.git.run(() => this.browseRepo.fetch());
  }

  refs(): Promise<string[]> {
    return this.git.run(async () => (await this.browseRepo.remoteBranches()).filter((name) => isBranchAllowed(this.allowedBranches, name)).sort());
  }

  pin(ref: string): Promise<string> {
    return this.git.run(async () => {
      const sha = await this.resolve(ref);
      await this.browseRepo.pin(sha);
      return sha;
    });
  }

  release(sha: string): Promise<void> {
    return this.git.run(() => this.browseRepo.unpin(sha));
  }

  browse(ref: string): Promise<Workspace> {
    return this.git.run(async () => {
      const sha = await this.resolve(ref);
      await this.browseRepo.checkoutDetached(sha);
      assertCatalog(this.browseRepo.dir);
      return { dir: this.browseRepo.dir, sha };
    });
  }

  /**
   * Only for a commit that was pinned when its job was queued: that is what proves it came from an allowed
   * branch and still exists, and it closes the gap between pinning and running. The whole preparation holds the
   * run folder's own lock, so two preparations can never interleave their checkout and install; browsing and
   * fetching (the git mutex) never wait for the install.
   */
  prepareRun(sha: string): Promise<Workspace> {
    return this.runFolder.run(async () => {
      if (!COMMIT_SHA.test(sha)) throw new CommitUnavailableError(sha);
      await this.git.run(async () => {
        if (!(await this.runRepo.isPinned(sha))) throw new CommitUnavailableError(sha);
        await this.runRepo.checkoutDetached(sha);
        assertCatalog(this.runRepo.dir);
      });
      await this.installer.ensure(this.runRepo.dir);
      return { dir: this.runRepo.dir, sha };
    });
  }

  prunePins(keep: ReadonlySet<string>): Promise<number> {
    return this.git.run(async () => {
      let released = 0;
      for (const sha of await this.browseRepo.pinned()) {
        if (keep.has(sha)) continue;
        await this.browseRepo.unpin(sha);
        released++;
      }
      return released;
    });
  }

  /** Branch name -> commit. Only well-formed, allowed branch names reach git; tags and raw commit ids never do. */
  private async resolve(ref: string): Promise<string> {
    if (!isValidBranchName(ref) || !isBranchAllowed(this.allowedBranches, ref)) throw new RefNotAllowedError(ref);
    const sha = await this.browseRepo.remoteCommit(ref);
    if (!sha) throw new RefNotFoundError(ref);
    return sha;
  }
}

function assertCatalog(dir: string): void {
  if (!fs.existsSync(path.join(dir, CATALOG_MARKER))) {
    throw new CatalogError(`This commit has no ${CATALOG_MARKER}: it is not a perfect-qa catalog`);
  }
}
