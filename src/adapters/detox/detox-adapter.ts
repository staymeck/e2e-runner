import type { JobRequestInput, ProjectAdapter } from "../../core/adapter";
import type { CatalogWorkspaces } from "./catalog-workspaces";
import { DETOX_KINDS, validateDetoxRequest } from "./detox-request";
import { DetoxExecutor, type DetoxExecutorDeps } from "./detox-executor";

export const DETOX_PROJECT_ID = "detox";
/** Every Detox job needs the physical devices and their ports: one at a time. */
export const DETOX_LOCKS: readonly string[] = ["devices"];

export interface DetoxAdapter extends ProjectAdapter {
  readonly executor: DetoxExecutor;
  /** For the endpoints that browse branches and scenarios (they never touch the run folder). */
  readonly catalog: CatalogWorkspaces;
}

/** The Detox project, assembled from its parts. The core knows it only through `ProjectAdapter`. */
export function createDetoxAdapter(deps: DetoxExecutorDeps, id: string = DETOX_PROJECT_ID): DetoxAdapter {
  return {
    id,
    locks: DETOX_LOCKS,
    kinds: DETOX_KINDS,
    refs: deps.catalog,
    catalog: deps.catalog,
    executor: new DetoxExecutor(deps),
    validateRequest: (request: JobRequestInput) => validateDetoxRequest(request),
  };
}
