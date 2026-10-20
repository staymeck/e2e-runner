import * as fs from "node:fs";
import * as path from "node:path";
import type { Problems } from "../../core/problems";
import { CATALOG_MARKER } from "./catalog-workspaces";
import type { GitRepo } from "./git-repo";

/** `git@host:org/repo.git`, `https://host/org/repo/` and `ssh://git@host/org/repo.git` name the same repository when written alike. */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Checks, at start-up, that the two folders really are two working trees of the one catalog repository
 * the project is configured for. Reports every problem instead of stopping at the first.
 */
export async function checkWorkspaces(runner: GitRepo, browser: GitRepo, expectedRepo: string, problems: Problems): Promise<void> {
  const folders = [
    { label: "E2E_DETOX_RUNNER_DIR", repo: runner },
    { label: "E2E_DETOX_INFO_DIR", repo: browser },
  ];
  const commonDirs: string[] = [];
  for (const { label, repo } of folders) {
    let commonDir: string;
    try {
      commonDir = await repo.commonDir();
    } catch {
      problems.add(`${label} is not a git working tree: ${repo.dir}`);
      continue;
    }
    commonDirs.push(commonDir);

    if (!fs.existsSync(path.join(repo.dir, CATALOG_MARKER))) {
      problems.add(`${label} has no ${CATALOG_MARKER}: it is not a perfect-qa catalog (${repo.dir})`);
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
}
