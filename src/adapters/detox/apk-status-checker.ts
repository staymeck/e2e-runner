import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ApkScenarioStatus } from "../../core/adapter";
import { CommandFailedError, type CommandRunner } from "../../core/command-runner";
import { orchestratorBin } from "./scenario-lister";

export const SUPPORTED_APK_STATUS_CONTRACT_VERSION = 1;
const STATUS_TIMEOUT_MS = 30_000;

/** The catalog's installed orchestrator is too old to report APK status (no `apk-status` command). */
export class ApkStatusUnsupportedError extends Error {
  constructor() {
    super("This catalog's orchestrator has no `apk-status` command: its branch is too old to be checked");
    this.name = "ApkStatusUnsupportedError";
  }
}

export class ApkStatusReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApkStatusReadError";
  }
}

/** Accepts exactly contract version 1; unknown fields are ignored, an unknown version is refused. */
export function parseApkStatus(document: unknown): ApkScenarioStatus {
  const root = document as { contractVersion?: unknown; scenarioId?: unknown; kind?: unknown; apps?: unknown } | null;
  if (root?.contractVersion !== SUPPORTED_APK_STATUS_CONTRACT_VERSION) {
    throw new ApkStatusReadError(`Unsupported apk-status contract version: ${String(root?.contractVersion)} (this service reads ${SUPPORTED_APK_STATUS_CONTRACT_VERSION})`);
  }
  if (typeof root.scenarioId !== "string" || root.scenarioId === "") throw new ApkStatusReadError("The apk-status listing has no scenarioId");
  if (typeof root.kind !== "string" || root.kind === "") throw new ApkStatusReadError("The apk-status listing has no kind");
  if (!Array.isArray(root.apps)) throw new ApkStatusReadError("The apk-status listing has no apps list");
  const apps = root.apps.map((entry: unknown) => {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.app !== "string" || row.app === "") throw new ApkStatusReadError("An apk-status row has no app");
    if (typeof row.branch !== "string") throw new ApkStatusReadError(`App "${row.app}" has no branch`);
    if (typeof row.ready !== "boolean") throw new ApkStatusReadError(`App "${row.app}" has no ready flag`);
    return { app: row.app, branch: row.branch, ready: row.ready, ...(typeof row.customId === "string" ? { customId: row.customId } : {}) };
  });
  return { scenarioId: root.scenarioId, kind: root.kind, apps };
}

export interface ApkStatusLister {
  /** `null` when the scenario does not exist in the catalog at all. */
  status(catalogDir: string, scenarioId: string): Promise<ApkScenarioStatus | null>;
}

/** Runs `perfect-qa apk-status --json --scenario <id>` in the catalog folder. Read-only, never builds anything. */
export class CliApkStatusChecker implements ApkStatusLister {
  constructor(
    private readonly runner: CommandRunner,
    private readonly environment: () => Readonly<Record<string, string>>,
    private readonly node: string = process.execPath,
    /** Same reasoning as `CliScenarioLister`'s own `removeFromEnv`: see its comment. */
    private readonly removeFromEnv: readonly string[] = [],
  ) {}

  async status(catalogDir: string, scenarioId: string): Promise<ApkScenarioStatus | null> {
    const bin = orchestratorBin(catalogDir);
    if (!fs.existsSync(bin)) throw new ApkStatusReadError(`The catalog has no installed orchestrator (${bin} is missing): dependencies are not installed`);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-apk-status-"));
    const out = path.join(scratch, "apk-status.json");
    try {
      try {
        await this.runner.run(this.node, [bin, "apk-status", "--json", "--scenario", scenarioId, "--out", out], {
          cwd: catalogDir,
          timeoutMs: STATUS_TIMEOUT_MS,
          minimalEnv: false,
          removeEnv: this.removeFromEnv,
          env: { ...this.environment(), PERFECT_QA_ORIGINAL_DIR: catalogDir, ORCH_CATALOG_ROOT: catalogDir },
        });
      } catch (error) {
        if (error instanceof CommandFailedError && /unknown command ['"`]?apk-status/i.test(error.message)) throw new ApkStatusUnsupportedError();
        if (error instanceof CommandFailedError && /unknown scenario/i.test(error.message)) return null;
        throw new ApkStatusReadError(error instanceof Error ? error.message : String(error));
      }
      let document: unknown;
      try {
        document = JSON.parse(fs.readFileSync(out, "utf8"));
      } catch {
        throw new ApkStatusReadError("The apk-status listing is missing or is not valid JSON");
      }
      return parseApkStatus(document);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
