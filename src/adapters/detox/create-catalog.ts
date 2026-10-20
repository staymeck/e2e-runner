import type { CommandRunner } from "../../core/command-runner";
import { ConfigError, Problems } from "../../core/problems";
import type { ProjectConfig } from "../../config/service-config";
import { GitCatalogWorkspaces, type CatalogWorkspaces } from "./catalog-workspaces";
import type { DetoxConfig } from "./detox-config";
import type { DependencyInstaller } from "./dependency-installer";
import { GitRepo } from "./git-repo";
import { checkWorkspaces } from "./workspace-check";

/**
 * Builds the catalog for the Detox project after checking, once, that the two folders really are two
 * worktrees of its repository. Throws a ConfigError listing every problem, so a wrong deployment stops at
 * start-up with a message instead of failing in the middle of a job.
 */
export async function createDetoxCatalog(
  detox: DetoxConfig,
  project: ProjectConfig,
  runner: CommandRunner,
  installer: DependencyInstaller,
): Promise<CatalogWorkspaces> {
  const runRepo = new GitRepo(detox.runnerDir, runner);
  const browseRepo = new GitRepo(detox.infoDir, runner);

  const problems = new Problems();
  await checkWorkspaces(runRepo, browseRepo, project.repo, problems);
  if (problems.any) throw new ConfigError(problems.list);

  return new GitCatalogWorkspaces(runRepo, browseRepo, project.allowedBranches, installer);
}
