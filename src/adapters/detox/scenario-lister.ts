import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandFailedError, type CommandRunner } from "../../core/command-runner";

export const SUPPORTED_CONTRACT_VERSION = 1;
const LIST_TIMEOUT_MS = 120_000;
const CLI_BIN = path.join("node_modules", "@perfect", "e2e-orchestrator", "bin", "perfect-qa.js");

export interface ScenarioInfo {
  readonly id: string;
  readonly kind: "step" | "batch";
  readonly title: string | null;
  readonly description: string | null;
  readonly apps: readonly string[];
  readonly appRefs: ReadonlyArray<{ readonly name: string; readonly branch: string }>;
}

/** The catalog's installed orchestrator is too old to list scenarios (no `scenarios` command). */
export class ScenariosUnsupportedError extends Error {
  constructor() {
    super("This catalog's orchestrator has no `scenarios` command: its branch is too old to be listed");
    this.name = "ScenariosUnsupportedError";
  }
}

export class ScenarioListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioListingError";
  }
}

/** Where `perfect-qa` is, inside a catalog folder (the catalog installs its own orchestrator). */
export function orchestratorBin(catalogDir: string): string {
  return path.join(catalogDir, CLI_BIN);
}

export function orchestratorPackageRoot(catalogDir: string): string {
  return path.join(catalogDir, "node_modules", "@perfect", "e2e-orchestrator");
}

export interface ScenarioLister {
  /** The scenarios the catalog checked out in `catalogDir` registers. */
  list(catalogDir: string): Promise<readonly ScenarioInfo[]>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ScenarioListingError(`${what} must be a list of text`);
  return value as string[];
}

/** Accepts exactly contract version 1; unknown fields are ignored, an unknown version is refused. */
export function parseScenarioListing(document: unknown): ScenarioInfo[] {
  const root = document as { contractVersion?: unknown; scenarios?: unknown } | null;
  if (root?.contractVersion !== SUPPORTED_CONTRACT_VERSION) {
    throw new ScenarioListingError(`Unsupported scenarios contract version: ${String(root?.contractVersion)} (this service reads ${SUPPORTED_CONTRACT_VERSION})`);
  }
  if (!Array.isArray(root.scenarios)) throw new ScenarioListingError("The scenarios listing has no scenarios list");
  return root.scenarios.map((entry: unknown): ScenarioInfo => {
    const scenario = entry as Record<string, unknown> | null;
    if (typeof scenario?.id !== "string" || scenario.id === "") throw new ScenarioListingError("A scenario has no id");
    if (scenario.kind !== "step" && scenario.kind !== "batch") throw new ScenarioListingError(`Scenario ${scenario.id} has an unknown kind`);
    const refs = Array.isArray(scenario.appRefs) ? scenario.appRefs : [];
    return {
      id: scenario.id,
      kind: scenario.kind,
      title: text(scenario.title),
      description: text(scenario.description),
      apps: strings(scenario.apps, `Scenario ${scenario.id}: apps`),
      appRefs: refs.map((ref: { name?: unknown; branch?: unknown }) => ({ name: String(ref.name), branch: String(ref.branch) })),
    };
  });
}

/** Runs `perfect-qa scenarios --json` in the catalog folder. It runs nothing and uses no device. */
export class CliScenarioLister implements ScenarioLister {
  constructor(
    private readonly runner: CommandRunner,
    private readonly environment: () => Readonly<Record<string, string>>,
    private readonly node: string = process.execPath,
    /**
     * Names to strip from the environment this runs with. Needed because `CommandRunner.run` with
     * `minimalEnv: false` rebuilds its base environment from its own process, not from `environment()`
     * alone: a name this omits is not thereby deleted if the runner still holds it. Whatever `environment()`
     * filters out must also be named here, or it can come back in.
     */
    private readonly removeFromEnv: readonly string[] = [],
  ) {}

  async list(catalogDir: string): Promise<readonly ScenarioInfo[]> {
    const bin = orchestratorBin(catalogDir);
    if (!fs.existsSync(bin)) throw new ScenarioListingError(`The catalog has no installed orchestrator (${bin} is missing): dependencies are not installed`);

    // The CLI prints log lines to stdout while it loads the catalog, so the document goes to a file.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-scenarios-"));
    const out = path.join(scratch, "scenarios.json");
    try {
      try {
        await this.runner.run(this.node, [bin, "scenarios", "--json", "--out", out], {
          cwd: catalogDir,
          timeoutMs: LIST_TIMEOUT_MS,
          minimalEnv: false,
          removeEnv: this.removeFromEnv,
          env: { ...this.environment(), PERFECT_QA_ORIGINAL_DIR: catalogDir, ORCH_CATALOG_ROOT: catalogDir },
        });
      } catch (error) {
        if (error instanceof CommandFailedError && /unknown command ['"`]?scenarios/i.test(error.message)) throw new ScenariosUnsupportedError();
        throw new ScenarioListingError(error instanceof Error ? error.message : String(error));
      }
      let document: unknown;
      try {
        document = JSON.parse(fs.readFileSync(out, "utf8"));
      } catch {
        throw new ScenarioListingError("The scenarios listing is missing or is not valid JSON");
      }
      return parseScenarioListing(document);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
