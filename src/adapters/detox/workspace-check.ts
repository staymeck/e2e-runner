import * as fs from "node:fs";
import * as path from "node:path";
import type { Problems } from "../../core/problems";
import { CATALOG_MARKER } from "./catalog-workspaces";
import type { GitRepo } from "./git-repo";

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
const SCP_LIKE = /^(?:[^@/\\\s]+@)?([^:/\\\s]+):(?!\/\/)(.+)$/;

function trimRepoPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/**
 * A repository, reduced to `host/path` so the same one compares equal however it is written:
 * `git@host:org/repo.git`, `ssh://git@host:22/org/repo` and `https://token@host/org/repo/` all become
 * `host/org/repo`. Credentials, scheme, port and a trailing `.git` or slash do not count; case does not either
 * (the usual hosts ignore it). A local path (tests, mirrors) compares as a path.
 */
export function normalizeRepoUrl(url: string): string {
  const value = url.trim();
  if (WINDOWS_PATH.test(value)) return `local/${trimRepoPath(value)}`;
  const scp = SCP_LIKE.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `${(scp[1] as string).toLowerCase()}/${trimRepoPath(scp[2] as string)}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") return `local/${trimRepoPath(decodeURIComponent(parsed.pathname))}`;
    return `${parsed.hostname.toLowerCase()}/${trimRepoPath(decodeURIComponent(parsed.pathname))}`;
  } catch {
    return `local/${trimRepoPath(value)}`;
  }
}

/** A path as comparable text: normalized, and case-folded where the filesystem folds it. */
function comparable(real: string): string {
  const normalized = path.normalize(real);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * Checks, at start-up, that each folder is the root of a clean git working tree and that the two are
 * working trees of the one catalog repository the project is configured for. Reports every problem instead
 * of stopping at the first.
 *
 * "Clean" matters: the run folder is force-checked-out and cleaned before every job, so a folder with someone's
 * uncommitted work in it (a developer clone) must be refused here, not wiped later.
 */
export async function checkWorkspaces(runner: GitRepo, browser: GitRepo, expectedRepo: string, problems: Problems): Promise<void> {
  const folders = [
    { label: "E2E_DETOX_RUNNER_DIR", repo: runner },
    { label: "E2E_DETOX_INFO_DIR", repo: browser },
  ];
  const commonDirs: string[] = [];
  const roots: string[] = [];
  for (const { label, repo } of folders) {
    let commonDir: string;
    let root: string;
    try {
      commonDir = await repo.commonDir();
      root = await repo.topLevel();
    } catch {
      problems.add(`${label} is not a git working tree: ${repo.dir}`);
      continue;
    }
    commonDirs.push(commonDir);
    roots.push(root);

    if (comparable(root) !== comparable(fs.realpathSync.native(repo.dir))) {
      problems.add(`${label} is a sub-folder of a working tree (${root}), not its root: point it at the root`);
    }
    if (!fs.existsSync(path.join(repo.dir, CATALOG_MARKER))) {
      problems.add(`${label} has no ${CATALOG_MARKER}: it is not a perfect-qa catalog (${repo.dir})`);
    }
    if (!(await repo.isClean())) {
      problems.add(`${label} has uncommitted changes or untracked files: the service resets this folder before every use, so it must be a dedicated one`);
    }
    const remote = await repo.remoteUrl();
    if (remote === undefined) {
      problems.add(`${label} has no "origin" remote`);
    } else if (normalizeRepoUrl(remote) !== normalizeRepoUrl(expectedRepo)) {
      problems.add(`${label}: origin is a different repository from the project's "repo" setting`);
    }
  }
  if (commonDirs.length === 2 && commonDirs[0] !== commonDirs[1]) {
    problems.add(
      "E2E_DETOX_RUNNER_DIR and E2E_DETOX_INFO_DIR are separate clones. Create the second as a worktree of the first " +
        "(`git worktree add --detach <folder> <commit>`) so one fetch serves both and pinned commits are shared",
    );
  }
  if (roots.length === 2 && comparable(roots[0] as string) === comparable(roots[1] as string)) {
    problems.add("E2E_DETOX_RUNNER_DIR and E2E_DETOX_INFO_DIR are the same working tree");
  }
}
