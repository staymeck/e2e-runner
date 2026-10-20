import * as fs from "node:fs";
import * as path from "node:path";
import { CommandFailedError, type CommandRunner } from "../../core/command-runner";
import { COMMIT_SHA } from "../../core/job-request";

const FETCH_TIMEOUT_MS = 120_000;
const CHECKOUT_TIMEOUT_MS = 180_000;
const LOCAL_GIT_TIMEOUT_MS = 30_000;
const REMOTE = "origin";
export const PIN_NAMESPACE = "refs/e2e/pins";

/** Git must never stop to ask something: no prompts. */
const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

/** Variables that would send git to some other repository than the folder it is run in. */
const REDIRECTING_ENV: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];

/** A thin, typed layer over the git commands the service needs, run in one working tree. Arguments are never joined into a string. */
export class GitRepo {
  private sshEnv: Promise<Record<string, string>> | undefined;

  constructor(
    readonly dir: string,
    private readonly runner: CommandRunner,
    private readonly env: Readonly<Record<string, string>> = {},
  ) {}

  private async exec(args: readonly string[], timeoutMs: number, extraEnv: Readonly<Record<string, string>>): Promise<string> {
    const env = { ...NON_INTERACTIVE_ENV, ...extraEnv, ...this.env };
    const result = await this.runner.run("git", args, { cwd: this.dir, timeoutMs, env, removeEnv: REDIRECTING_ENV });
    return result.stdout;
  }

  private async git(args: readonly string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): Promise<string> {
    return this.exec(args, timeoutMs, await this.nonInteractiveSsh());
  }

  /**
   * Like `git`, but for questions whose answer can be "no": an exit code in `noCodes` means "absent" (undefined).
   * Any other failure (timeout, corrupt repository, I/O error) is a real error and is thrown, never mistaken for "no".
   */
  private async ask(args: readonly string[], noCodes: readonly number[] = [1]): Promise<string | undefined> {
    const ssh = await this.nonInteractiveSsh(); // outside the try: a failure here is not an answer to the question
    try {
      return await this.exec(args, LOCAL_GIT_TIMEOUT_MS, ssh);
    } catch (error) {
      if (error instanceof CommandFailedError && error.exitCode !== null && noCodes.includes(error.exitCode)) return undefined;
      throw error;
    }
  }

  /**
   * Only the fetch talks to the network, and it must never wait for a password. If the deployment chose its
   * ssh command (the environment or the repository's `core.sshCommand`, e.g. one naming the deploy key) we leave it alone.
   */
  private nonInteractiveSsh(): Promise<Record<string, string>> {
    this.sshEnv ??= this.chooseSsh();
    return this.sshEnv;
  }

  private async chooseSsh(): Promise<Record<string, string>> {
    if (process.env.GIT_SSH_COMMAND || this.env.GIT_SSH_COMMAND) return {};
    let configured: string | undefined;
    try {
      configured = await this.exec(["config", "--get", "core.sshCommand"], LOCAL_GIT_TIMEOUT_MS, {});
    } catch (error) {
      if (!(error instanceof CommandFailedError) || error.exitCode !== 1) throw error; // exit 1: the setting is simply not there
    }
    return configured?.trim() ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  }

  /** Brings every remote branch up to date; branches deleted upstream disappear. No tags, no submodules, and no background gc. */
  async fetch(): Promise<void> {
    await this.git(["-c", "gc.auto=0", "fetch", "--prune", "--no-tags", "--no-recurse-submodules", REMOTE], FETCH_TIMEOUT_MS);
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
    const out = await this.ask(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}^{commit}`]);
    const sha = out?.trim();
    return sha && COMMIT_SHA.test(sha) ? sha : undefined;
  }

  /** Whether a commit is pinned (and so cannot have been garbage collected). */
  async isPinned(sha: string): Promise<boolean> {
    if (!COMMIT_SHA.test(sha)) return false;
    return (await this.ask(["rev-parse", "--verify", "--quiet", `${PIN_NAMESPACE}/${sha}^{commit}`])) !== undefined;
  }

  /** Puts the working tree exactly on `sha`, detached, throwing away local changes and untracked files (ignored files are kept). */
  async checkoutDetached(sha: string): Promise<void> {
    if (!COMMIT_SHA.test(sha)) throw new Error("not a commit id");
    await this.git(["checkout", "--detach", "--force", "--quiet", sha], CHECKOUT_TIMEOUT_MS);
    await this.git(["clean", "-ffd", "--quiet"], CHECKOUT_TIMEOUT_MS); // -ff also removes nested git repositories
  }

  /** True when the working tree has no uncommitted changes and no untracked files (ignored files do not count). */
  async isClean(): Promise<boolean> {
    return (await this.git(["status", "--porcelain"])).trim() === "";
  }

  /** The real path of the working tree's root, wherever inside it `dir` points. */
  async topLevel(): Promise<string> {
    return fs.realpathSync.native((await this.git(["rev-parse", "--show-toplevel"])).trim());
  }

  /** Absolute path of the repository's shared git directory: two worktrees of one repository report the same one. */
  async commonDir(): Promise<string> {
    const out = (await this.git(["rev-parse", "--git-common-dir"])).trim();
    return fs.realpathSync.native(path.resolve(this.dir, out));
  }

  async remoteUrl(): Promise<string | undefined> {
    // `git remote get-url` exits 2 for a remote that does not exist
    return (await this.ask(["remote", "get-url", REMOTE], [2]))?.trim();
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
