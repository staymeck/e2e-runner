import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandRunner } from "../../core/command-runner";
import { COMMIT_SHA } from "../../core/job-request";

const GIT_TIMEOUT_MS = 120_000;
const LOCAL_GIT_TIMEOUT_MS = 30_000;
const REMOTE = "origin";
export const PIN_NAMESPACE = "refs/e2e/pins";

/** Git must never stop to ask something: no prompts, and ssh only with the key it is given. */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

/** A thin, typed layer over the git commands the service needs, run in one working tree. Arguments are never joined into a string. */
export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly runner: CommandRunner,
    private readonly env: Readonly<Record<string, string>> = {},
  ) {}

  private async git(args: readonly string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): Promise<string> {
    const ssh: Record<string, string> = process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }; // never wait for a password
    const result = await this.runner.run("git", args, { cwd: this.dir, timeoutMs, env: { ...NON_INTERACTIVE_ENV, ...ssh, ...this.env } });
    return result.stdout;
  }

  /** Brings every remote branch up to date; branches deleted upstream disappear. */
  async fetch(): Promise<void> {
    await this.git(["fetch", "--prune", "--no-tags", REMOTE], GIT_TIMEOUT_MS);
  }

  /** Names of the remote branches, without the `origin/` prefix. */
  async remoteBranches(): Promise<string[]> {
    const out = await this.git(["for-each-ref", "--format=%(refname)", `refs/remotes/${REMOTE}`]);
    const prefix = `refs/remotes/${REMOTE}/`;
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
      .filter((name) => name !== "HEAD");
  }

  /** The commit a remote branch points to, or undefined if there is no such branch. `branch` must already be a validated branch name. */
  async remoteCommit(branch: string): Promise<string | undefined> {
    try {
      const out = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}^{commit}`]);
      const sha = out.trim();
      return COMMIT_SHA.test(sha) ? sha : undefined;
    } catch {
      return undefined; // --quiet --verify exits 1 when the ref does not exist
    }
  }

  async hasCommit(sha: string): Promise<boolean> {
    if (!COMMIT_SHA.test(sha)) return false;
    try {
      await this.git(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Puts the working tree exactly on `sha`, detached, throwing away local changes and untracked files (ignored files are kept). */
  async checkoutDetached(sha: string): Promise<void> {
    if (!COMMIT_SHA.test(sha)) throw new Error("not a commit id");
    await this.git(["checkout", "--detach", "--force", "--quiet", sha]);
    await this.git(["clean", "-fd", "--quiet"]);
  }

  async head(): Promise<string | undefined> {
    try {
      const sha = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
      return COMMIT_SHA.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  /** True when HEAD is detached (not on any branch). */
  async isDetached(): Promise<boolean> {
    try {
      await this.git(["symbolic-ref", "--quiet", "HEAD"]);
      return false;
    } catch {
      return true;
    }
  }

  /** Absolute path of the repository's shared git directory: two worktrees of one repository report the same one. */
  async commonDir(): Promise<string> {
    const out = (await this.git(["rev-parse", "--git-common-dir"])).trim();
    return fs.realpathSync.native(path.resolve(this.dir, out));
  }

  async remoteUrl(): Promise<string | undefined> {
    try {
      return (await this.git(["remote", "get-url", REMOTE])).trim();
    } catch {
      return undefined;
    }
  }

  /** Keeps a commit from being garbage collected while a job may still need it. */
  async pin(sha: string): Promise<void> {
    if (!COMMIT_SHA.test(sha)) throw new Error("not a commit id");
    await this.git(["update-ref", `${PIN_NAMESPACE}/${sha}`, sha]);
  }

  async unpin(sha: string): Promise<void> {
    if (!COMMIT_SHA.test(sha)) return;
    await this.git(["update-ref", "-d", `${PIN_NAMESPACE}/${sha}`]);
  }

  /** Commits currently pinned. */
  async pinned(): Promise<string[]> {
    const out = await this.git(["for-each-ref", "--format=%(refname)", PIN_NAMESPACE]);
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(`${PIN_NAMESPACE}/`.length))
      .filter((sha) => COMMIT_SHA.test(sha));
  }
}
