import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A catalog repository as the service sees it: a bare "remote", and a runner and an info folder that are
 * two worktrees of one clone. `seed` is a separate clone used to publish commits like a developer would.
 */
export class CatalogFixture {
  readonly remote: string;
  readonly seed: string;
  readonly runnerDir: string;
  readonly infoDir: string;

  constructor(readonly root: string) {
    this.remote = path.join(root, "remote.git");
    this.seed = path.join(root, "seed");
    this.runnerDir = path.join(root, "e2e-detox-runner");
    this.infoDir = path.join(root, "e2e-detox-info");

    git(root, "init", "--bare", "-b", "main", this.remote);
    git(root, "clone", "-q", this.remote, this.seed);
    git(this.seed, "checkout", "-q", "-b", "main");
    this.writeCatalog(this.seed);
    git(this.seed, "add", "-A");
    git(this.seed, "commit", "-q", "-m", "initial catalog");
    git(this.seed, "push", "-q", "origin", "main");
    this.branch("iteration_1", "main");
    this.branch("iteration_2", "main");
    this.branch("feature/not-allowed", "main");

    git(root, "clone", "-q", this.remote, this.runnerDir);
    git(this.runnerDir, "checkout", "-q", "--detach", "origin/iteration_1");
    git(this.runnerDir, "worktree", "add", "-q", "--detach", this.infoDir, "origin/iteration_1");
  }

  private writeCatalog(dir: string): void {
    fs.writeFileSync(path.join(dir, "orch.rc.json"), JSON.stringify({ e2eDir: "e2e-testing", defaultBranch: "iteration_1" }));
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nbuilds/\n.env\n");
  }

  /** Creates (or resets) a branch from another and publishes it. */
  branch(name: string, from: string): string {
    git(this.seed, "checkout", "-q", "-B", name, from);
    git(this.seed, "push", "-q", "--force", "origin", name);
    return this.sha(name);
  }

  /** Publishes a new commit on a branch, as a developer pushing would. */
  commit(branch: string, file: string, content: string): string {
    git(this.seed, "checkout", "-q", branch);
    fs.mkdirSync(path.dirname(path.join(this.seed, file)), { recursive: true });
    fs.writeFileSync(path.join(this.seed, file), content);
    git(this.seed, "add", "-A");
    git(this.seed, "commit", "-q", "-m", `change ${file}`);
    git(this.seed, "push", "-q", "origin", branch);
    return this.sha(branch);
  }

  /** Moves a branch to another commit even if that drops commits (a force-push). */
  forcePush(branch: string, to: string): void {
    git(this.seed, "checkout", "-q", "-B", branch, to);
    git(this.seed, "push", "-q", "--force", "origin", branch);
  }

  /** A commit that has no orch.rc.json, on a new branch. */
  uncatalogedBranch(name: string): string {
    git(this.seed, "checkout", "-q", "-B", name, "main");
    git(this.seed, "rm", "-q", "orch.rc.json");
    git(this.seed, "commit", "-q", "-m", "not a catalog");
    git(this.seed, "push", "-q", "--force", "origin", name);
    return this.sha(name);
  }

  deleteBranch(name: string): void {
    git(this.seed, "push", "-q", "origin", "--delete", name);
  }

  tag(name: string): void {
    git(this.seed, "tag", name);
    git(this.seed, "push", "-q", "origin", name);
  }

  sha(ref: string): string {
    return git(this.seed, "rev-parse", ref);
  }

  headOf(dir: string): string {
    return git(dir, "rev-parse", "HEAD");
  }

  /** Throws away every commit nothing points to, as `git gc` eventually does. */
  collectGarbage(): void {
    git(this.runnerDir, "reflog", "expire", "--expire=now", "--all");
    git(this.runnerDir, "gc", "-q", "--prune=now");
  }

  has(sha: string): boolean {
    try {
      git(this.runnerDir, "cat-file", "-e", `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  }
}
