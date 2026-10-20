import * as fs from "node:fs";
import * as path from "node:path";
import type { Problems } from "../../core/problems";

export const DETOX_ADAPTER = "detox";
export const RUNNER_DIR_VAR = "E2E_DETOX_RUNNER_DIR";
export const INFO_DIR_VAR = "E2E_DETOX_INFO_DIR";

export interface DetoxConfig {
  /** Worktree where jobs run. Only the runner moves it, between jobs. */
  readonly runnerDir: string;
  /** Worktree used to browse branches and scenarios. The runner never touches it. */
  readonly infoDir: string;
}

interface Folder {
  readonly label: string;
  readonly real: string;
  /** device:inode when the filesystem reports a real one; catches two names for one folder. */
  readonly identity: string | undefined;
}

const CASE_INSENSITIVE_PLATFORMS: readonly NodeJS.Platform[] = ["win32", "darwin"];

function describe(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unreadable";
}

function readFolder(env: NodeJS.ProcessEnv, name: string, problems: Problems): Folder | undefined {
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
    // Some filesystems report inode 0 for everything: it says nothing about identity.
    const identity = stat.ino === 0n ? undefined : `${stat.dev}:${stat.ino}`;
    return { label: name, real: fs.realpathSync.native(value), identity };
  } catch (error) {
    problems.add(`${name} cannot be used (${describe(error)}): ${value}`);
    return undefined;
  }
}

/**
 * The folder the service keeps its data in may not exist yet: resolve its nearest existing
 * ancestor and re-attach the rest, so links in the existing part still resolve.
 */
export function resolveFutureDir(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function comparable(real: string): string {
  const normalized = path.normalize(real);
  return CASE_INSENSITIVE_PLATFORMS.includes(process.platform) ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Two folders must be different and neither may contain the other (real paths and identity). */
export function checkSeparate(a: Folder, b: Folder, problems: Problems): void {
  const pathA = comparable(a.real);
  const pathB = comparable(b.real);
  const same = pathA === pathB || (a.identity !== undefined && a.identity === b.identity);
  if (same) {
    problems.add(`${a.label} and ${b.label} point to the same folder (${a.real}); they must be different`);
  } else if (isInside(pathA, pathB) || isInside(pathB, pathA)) {
    problems.add(`${a.label} and ${b.label} must not contain one another (${a.real} / ${b.real})`);
  }
}

/**
 * The runner folder and the info folder must be two different folders: browsing a branch
 * must never move the tree a job is running in. The data folder must stay clear of both:
 * a checkout or `git clean` in a worktree would otherwise delete the service's own database.
 */
export function loadDetoxConfig(env: NodeJS.ProcessEnv, dataDir: string, problems: Problems): DetoxConfig | undefined {
  const runner = readFolder(env, RUNNER_DIR_VAR, problems);
  const info = readFolder(env, INFO_DIR_VAR, problems);
  if (!runner || !info) return undefined;

  const before = problems.list.length;
  checkSeparate(runner, info, problems);
  if (dataDir) {
    const data: Folder = { label: "E2E_SERVICE_DATA_DIR", real: resolveFutureDir(dataDir), identity: undefined };
    checkSeparate(runner, data, problems);
    checkSeparate(info, data, problems);
  }
  if (problems.list.length > before) return undefined;
  return { runnerDir: runner.real, infoDir: info.real };
}
