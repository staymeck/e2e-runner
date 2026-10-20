import type { CatalogTarget, JobRequestInput, ProjectAdapter, ProjectCatalog } from "../../core/adapter";
import { CatalogReadError, InvalidJobRequestError } from "../../core/job-request";
import { CatalogError, type CatalogWorkspaces, type Workspace } from "./catalog-workspaces";
import { DETOX_KINDS, validateDetoxRequest } from "./detox-request";
import { DetoxExecutor, type DetoxExecutorDeps } from "./detox-executor";
import { ScenarioListingError, ScenariosUnsupportedError, type ScenarioLister } from "./scenario-lister";

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

/** The Detox project, assembled from its parts. The core knows it only through `ProjectAdapter`. */
export function createDetoxAdapter(deps: DetoxExecutorDeps, id: string = DETOX_PROJECT_ID): DetoxAdapter {
  return {
    id,
    locks: DETOX_LOCKS,
    kinds: DETOX_KINDS,
    refs: deps.catalog,
    catalog: deps.catalog,
    browsable: browsableCatalog(deps.catalog, deps.lister),
    executor: new DetoxExecutor(deps),
    validateRequest: (request: JobRequestInput) => validateDetoxRequest(request),
  };
}
