import * as fs from "node:fs";
import * as path from "node:path";
import type { Problems } from "../../config/problems";

export const DETOX_ADAPTER = "detox";
export const RUNNER_DIR_VAR = "E2E_DETOX_RUNNER_DIR";
export const INFO_DIR_VAR = "E2E_DETOX_INFO_DIR";

export interface DetoxConfig {
  /** Worktree where jobs run. Only the runner moves it, between jobs. */
  readonly runnerDir: string;
  /** Worktree used to browse branches and scenarios. The runner never touches it. */
  readonly infoDir: string;
}

interface ResolvedDir {
  readonly real: string;
  readonly identity: string;
}

function readDir(env: NodeJS.ProcessEnv, name: string, problems: Problems): ResolvedDir | undefined {
  const value = env[name]?.trim();
  if (!value) {
    problems.add(`${name} is required when a project uses the "${DETOX_ADAPTER}" adapter`);
    return undefined;
  }
  if (!path.isAbsolute(value)) {
    problems.add(`${name} must be an absolute path (got "${value}")`);
    return undefined;
  }
  try {
    const stat = fs.statSync(value, { bigint: true });
    if (!stat.isDirectory()) {
      problems.add(`${name} is not a directory: ${value}`);
      return undefined;
    }
    return { real: fs.realpathSync.native(value), identity: `${stat.dev}:${stat.ino}` };
  } catch {
    problems.add(`${name} does not exist: ${value}`);
    return undefined;
  }
}

const CASE_INSENSITIVE_PLATFORMS: readonly NodeJS.Platform[] = ["win32", "darwin"];

function comparable(real: string): string {
  const normalized = path.normalize(real);
  return CASE_INSENSITIVE_PLATFORMS.includes(process.platform) ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The runner folder and the info folder must be two different folders: browsing a branch
 * must never move the tree a job is running in. Compared by real path (so links resolve),
 * by file identity (so two names for one folder are caught) and for nesting.
 */
export function checkDistinctDirs(runner: ResolvedDir, info: ResolvedDir, problems: Problems): void {
  const a = comparable(runner.real);
  const b = comparable(info.real);
  if (a === b || runner.identity === info.identity) {
    problems.add(`${RUNNER_DIR_VAR} and ${INFO_DIR_VAR} point to the same folder (${runner.real}); they must be different`);
  } else if (isInside(a, b) || isInside(b, a)) {
    problems.add(`${RUNNER_DIR_VAR} and ${INFO_DIR_VAR} must not contain one another (${runner.real} / ${info.real})`);
  }
}

export function loadDetoxConfig(env: NodeJS.ProcessEnv, problems: Problems): DetoxConfig | undefined {
  const runner = readDir(env, RUNNER_DIR_VAR, problems);
  const info = readDir(env, INFO_DIR_VAR, problems);
  if (!runner || !info) return undefined;
  const before = problems.list.length;
  checkDistinctDirs(runner, info, problems);
  if (problems.list.length > before) return undefined;
  return { runnerDir: runner.real, infoDir: info.real };
}
