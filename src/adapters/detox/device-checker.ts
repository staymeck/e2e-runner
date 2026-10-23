import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceStatus } from "../../core/adapter";
import { CommandFailedError, type CommandRunner } from "../../core/command-runner";
import { orchestratorBin } from "./scenario-lister";

export const SUPPORTED_DEVICES_CONTRACT_VERSION = 1;
const LIST_TIMEOUT_MS = 30_000;
const DEVICE_STATES: readonly string[] = ["connected", "disconnected", "unauthorized"];

/** The catalog's installed orchestrator is too old to list devices (no `devices` command). */
export class DevicesUnsupportedError extends Error {
  constructor() {
    super("This catalog's orchestrator has no `devices` command: its branch is too old to be listed");
    this.name = "DevicesUnsupportedError";
  }
}

export class DeviceListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceListingError";
  }
}

/** Accepts exactly contract version 1; unknown fields are ignored, an unknown version is refused. */
export function parseDeviceListing(document: unknown): DeviceStatus[] {
  const root = document as { contractVersion?: unknown; devices?: unknown } | null;
  if (root?.contractVersion !== SUPPORTED_DEVICES_CONTRACT_VERSION) {
    throw new DeviceListingError(`Unsupported devices contract version: ${String(root?.contractVersion)} (this service reads ${SUPPORTED_DEVICES_CONTRACT_VERSION})`);
  }
  if (!Array.isArray(root.devices)) throw new DeviceListingError("The devices listing has no devices list");
  return root.devices.map((entry: unknown): DeviceStatus => {
    const device = entry as Record<string, unknown> | null;
    if (typeof device?.name !== "string" || device.name === "") throw new DeviceListingError("A device has no name");
    if (typeof device.state !== "string" || !DEVICE_STATES.includes(device.state)) throw new DeviceListingError(`Device ${device.name} has an unknown state`);
    return { name: device.name, state: device.state as DeviceStatus["state"] };
  });
}

export interface DeviceLister {
  /** The devices the catalog checked out in `catalogDir` configures, with their real adb state. */
  list(catalogDir: string): Promise<readonly DeviceStatus[]>;
}

/** Runs `perfect-qa devices --json` in the catalog folder. Read-only: does not attempt `adb connect`. */
export class CliDeviceChecker implements DeviceLister {
  constructor(
    private readonly runner: CommandRunner,
    private readonly environment: () => Readonly<Record<string, string>>,
    private readonly node: string = process.execPath,
    /** Same reasoning as `CliScenarioLister`'s own `removeFromEnv`: see its comment. */
    private readonly removeFromEnv: readonly string[] = [],
  ) {}

  async list(catalogDir: string): Promise<readonly DeviceStatus[]> {
    const bin = orchestratorBin(catalogDir);
    if (!fs.existsSync(bin)) throw new DeviceListingError(`The catalog has no installed orchestrator (${bin} is missing): dependencies are not installed`);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-devices-"));
    const out = path.join(scratch, "devices.json");
    try {
      try {
        await this.runner.run(this.node, [bin, "devices", "--json", "--out", out], {
          cwd: catalogDir,
          timeoutMs: LIST_TIMEOUT_MS,
          minimalEnv: false,
          removeEnv: this.removeFromEnv,
          env: { ...this.environment(), PERFECT_QA_ORIGINAL_DIR: catalogDir, ORCH_CATALOG_ROOT: catalogDir },
        });
      } catch (error) {
        if (error instanceof CommandFailedError && /unknown command ['"`]?devices/i.test(error.message)) throw new DevicesUnsupportedError();
        throw new DeviceListingError(error instanceof Error ? error.message : String(error));
      }
      let document: unknown;
      try {
        document = JSON.parse(fs.readFileSync(out, "utf8"));
      } catch {
        throw new DeviceListingError("The devices listing is missing or is not valid JSON");
      }
      return parseDeviceListing(document);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
