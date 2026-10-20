import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandRunner } from "../../core/command-runner";

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const LOCKFILE = "package-lock.json";
const MARKER_DIR = "node_modules";
const MARKER_FILE = ".e2e-runner-install";

export class MissingLockfileError extends Error {
  constructor(dir: string) {
    super(`${path.join(dir, LOCKFILE)} does not exist: the catalog must commit its lockfile so installs are reproducible`);
    this.name = "MissingLockfileError";
  }
}

/** Makes the dependencies of a working tree match its lockfile. */
export interface DependencyInstaller {
  /** Installs only if needed. Returns whether an install ran. */
  ensure(dir: string): Promise<boolean>;
}

/**
 * `npm ci` in the working tree, only when something changed: the lockfile, the Node version, or the
 * installed tree itself is missing. The state is recorded inside `node_modules`, so deleting that folder
 * is always enough to force a fresh install.
 *
 * `npm ci` runs the catalog's install scripts as the service's user: anyone who can push to an allowed
 * branch can run code on this host. That is why `allowedBranches` is a security control (see docs/design.md).
 */
export class NpmInstaller implements DependencyInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly nodeVersion: string = process.version,
  ) {}

  async ensure(dir: string): Promise<boolean> {
    const wanted = this.fingerprint(dir);
    const marker = path.join(dir, MARKER_DIR, MARKER_FILE);
    if (this.readMarker(marker) === wanted) return false;

    await this.runner.run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, wanted, "utf8");
    return true;
  }

  private fingerprint(dir: string): string {
    const lockfile = path.join(dir, LOCKFILE);
    if (!fs.existsSync(lockfile)) throw new MissingLockfileError(dir);
    const hash = createHash("sha256").update(fs.readFileSync(lockfile)).digest("hex");
    return `${hash}\n${this.nodeVersion}`;
  }

  private readMarker(marker: string): string | undefined {
    try {
      return fs.readFileSync(marker, "utf8");
    } catch {
      return undefined;
    }
  }
}
