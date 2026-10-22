import type { CatalogTarget, DeviceChecker, DeviceStatus, JobRequestInput, ProjectAdapter, ProjectCatalog, Readiness } from "../../core/adapter";
import type { Job } from "../../core/job";
import { CatalogReadError, InvalidJobRequestError } from "../../core/job-request";
import { CatalogError, type CatalogWorkspaces, type Workspace } from "./catalog-workspaces";
import type { DeviceLister } from "./device-checker";
import { DETOX_KINDS, namesAScenario, validateDetoxRequest } from "./detox-request";
import { DetoxExecutor, type DetoxExecutorDeps } from "./detox-executor";
import { ScenarioListingError, ScenariosUnsupportedError, type ScenarioInfo, type ScenarioLister } from "./scenario-lister";

export const DETOX_PROJECT_ID = "detox";
/** Every Detox job needs the physical devices and their ports: one at a time. */
export const DETOX_LOCKS: readonly string[] = ["devices"];

export interface DetoxAdapter extends ProjectAdapter {
  readonly executor: DetoxExecutor;
  /** For the endpoints that browse branches and scenarios (they never touch the run folder). */
  readonly catalog: CatalogWorkspaces;
}

/**
 * `browse` positions the one browsing folder the catalog has; `targets` then lists whatever commit it is
 * now on. There is exactly one such folder (the whole service is built on that), so remembering the last
 * `Workspace` here is not an extra assumption, just naming the one that already exists.
 */
function browsableCatalog(catalog: CatalogWorkspaces, lister: ScenarioLister): ProjectCatalog {
  let browsed: Workspace | undefined;
  return {
    fetch: () => catalog.fetch(),
    refs: () => catalog.refs(),
    async browse(ref: string): Promise<{ sha: string }> {
      try {
        browsed = await catalog.browse(ref);
      } catch (error) {
        // Expected (an old branch with no catalog), not a bug: the API must not turn this into a 500.
        if (error instanceof CatalogError) throw new CatalogReadError(error.message);
        throw error;
      }
      return { sha: browsed.sha };
    },
    async targets(): Promise<readonly CatalogTarget[]> {
      if (!browsed) throw new InvalidJobRequestError("browse a branch before listing its targets");
      try {
        // Holds the same lock browse()/fetch() do: the folder it reads from must not be mid-checkout.
        const scenarios = await catalog.withBrowseLock((dir) => lister.list(dir));
        return scenarios.map((scenario): CatalogTarget => ({ id: scenario.id, title: scenario.title }));
      } catch (error) {
        // Expected (a branch too old for `scenarios`, or its dependencies not installed yet), not a bug.
        if (error instanceof ScenariosUnsupportedError || error instanceof ScenarioListingError) throw new CatalogReadError(error.message);
        throw error;
      }
    },
  };
}

/** Holds the same lock `browse`/`fetch`/`targets` do: devices aren't tied to a commit, but running
 * `perfect-qa` needs a stable, non-mid-checkout folder, and the browsing one is already available for
 * exactly that kind of read (STA-46). */
function devicesChecker(catalog: CatalogWorkspaces, deviceLister: DeviceLister): DeviceChecker {
  return {
    list: () => catalog.withBrowseLock((dir) => deviceLister.list(dir)),
  };
}

const CONNECTED: DeviceStatus["state"] = "connected";

/** `batch` always needs exactly one device slot; `step` needs one per app it creates (never fewer than one). */
function requiredDevices(scenario: ScenarioInfo): number {
  return scenario.kind === "batch" ? 1 : Math.max(1, scenario.apps.length);
}

/**
 * Whether this job's own scenario has enough devices connected right now. Only applies to a job that
 * names one scenario (`run`, or `build` of a specific target) — "build all" and a pipeline's own build
 * phase don't have a single scenario's device count to check against, so they are always ready here;
 * nothing stops the real run later from discovering a device problem the normal way.
 *
 * Reads the scenario's shape from the browsing folder's *current* position, not the job's own pinned
 * commit (the run folder is exclusively held by whichever job is actually running, not available to
 * peek at before a job is even claimed) — a deliberate, documented simplification: if the catalog's
 * branch changed enough to alter that scenario's app count between queueing and now, the estimate here
 * could be briefly stale. Never a safety issue: `canStart` fails open, and the real existence/shape
 * check the executor already does once a job starts is unaffected by this.
 */
async function detoxCanStart(job: Job, catalog: CatalogWorkspaces, lister: ScenarioLister, deviceLister: DeviceLister): Promise<Readiness> {
  if (!namesAScenario(job)) return { ready: true };
  const scenarios = await catalog.withBrowseLock((dir) => lister.list(dir));
  const scenario = scenarios.find((s) => s.id === job.target);
  if (!scenario) return { ready: true }; // unknown here; the executor's own check (at the right commit) is what actually matters
  const required = requiredDevices(scenario);
  const devices = await catalog.withBrowseLock((dir) => deviceLister.list(dir));
  const connected = devices.filter((d) => d.state === CONNECTED).length;
  if (connected >= required) return { ready: true };
  return { ready: false, reason: `Esperando dispositivos: ${connected} de ${required} conectados` };
}

/**
 * The Detox project, assembled from its parts. The core knows it only through `ProjectAdapter`.
 *
 * `devices`/`canStart` exist only when `deps.deviceLister` is actually given: a fixture or test that
 * never cared about device status (everything before STA-46) must not suddenly find its jobs stuck
 * queued forever because an absent device lister "honestly" reports zero devices connected — that is
 * a real empty answer, not the same thing as "there is no gate to check". Omitting the dependency is
 * how a caller opts out of the gate entirely, the same way `browsable` is already optional for an
 * adapter that cannot offer it.
 */
export function createDetoxAdapter(deps: DetoxExecutorDeps, id: string = DETOX_PROJECT_ID): DetoxAdapter {
  const deviceLister = deps.deviceLister;
  return {
    id,
    locks: DETOX_LOCKS,
    kinds: DETOX_KINDS,
    refs: deps.catalog,
    catalog: deps.catalog,
    browsable: browsableCatalog(deps.catalog, deps.lister),
    ...(deviceLister
      ? {
          devices: devicesChecker(deps.catalog, deviceLister),
          canStart: (job: Job) => detoxCanStart(job, deps.catalog, deps.lister, deviceLister),
        }
      : {}),
    executor: new DetoxExecutor(deps),
    validateRequest: (request: JobRequestInput) => validateDetoxRequest(request),
  };
}
