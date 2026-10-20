import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CatalogError, type CatalogWorkspaces } from "../src/adapters/detox/catalog-workspaces";
import { createDetoxAdapter, DETOX_LOCKS, DETOX_PROJECT_ID } from "../src/adapters/detox/detox-adapter";
import { ScenarioListingError, ScenariosUnsupportedError, type ScenarioInfo, type ScenarioLister } from "../src/adapters/detox/scenario-lister";
import { CatalogReadError, InvalidJobRequestError } from "../src/core/job-request";
import { FakeCatalog } from "./helpers/fake-orchestrator";

const scenario = (id: string, title: string | null = null): ScenarioInfo => ({ id, kind: "step", title, description: null, apps: [], appRefs: [] });

class FakeLister implements ScenarioLister {
  readonly listedDirs: string[] = [];
  constructor(private readonly byDir: Record<string, readonly ScenarioInfo[]> = {}) {}
  async list(dir: string): Promise<readonly ScenarioInfo[]> {
    this.listedDirs.push(dir);
    return this.byDir[dir] ?? [];
  }
}

function adapter(catalog: CatalogWorkspaces, lister: ScenarioLister) {
  return createDetoxAdapter({
    catalog,
    host: { start: () => { throw new Error("not used"); }, kill: () => undefined, commandLine: async () => undefined },
    lister,
    containers: { stopForJob: async () => [] },
    log: { append: () => undefined },
    environment: () => ({}),
  });
}

describe("createDetoxAdapter: identity and resources", () => {
  it("exposes the fixed Detox project id, locks and kinds", () => {
    const a = adapter(new FakeCatalog("/x"), new FakeLister());
    assert.equal(a.id, DETOX_PROJECT_ID);
    assert.deepEqual(a.locks, DETOX_LOCKS);
    assert.deepEqual(a.kinds, ["run", "build", "pipeline"]);
  });
});

describe("createDetoxAdapter.browsable", () => {
  it("passes fetch and refs straight through to the catalog", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const a = adapter(catalog, new FakeLister());
    await a.browsable!.fetch();
    assert.deepEqual(await a.browsable!.refs(), ["main"]);
  });

  it("browse resolves the branch through the catalog and returns only its commit", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const a = adapter(catalog, new FakeLister());
    const result = await a.browsable!.browse("main");
    assert.deepEqual(result, { sha: "a".repeat(40) });
    assert.deepEqual(catalog.pinned, ["a".repeat(40)]);
  });

  it("refuses to list targets before anything was browsed", async () => {
    const a = adapter(new FakeCatalog("/x"), new FakeLister());
    await assert.rejects(a.browsable!.targets(), InvalidJobRequestError);
  });

  it("lists the targets of whatever browse last positioned the catalog at, trimmed to id and title", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40), iteration_1: "b".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("login", "Login"), scenario("checkout")] });
    const a = adapter(catalog, lister);

    await a.browsable!.browse("main");
    assert.deepEqual(await a.browsable!.targets(), [{ id: "login", title: "Login" }, { id: "checkout", title: null }]);
    assert.deepEqual(lister.listedDirs, ["/x"]);
  });

  it("targets reflects the most recent browse, not the first one", async () => {
    // One physical folder, like the real catalog: withBrowseLock reports whichever branch was browsed
    // last, not whatever the Workspace of an earlier browse() call happened to carry.
    let lastBrowsed: string | undefined;
    const catalog: CatalogWorkspaces = {
      fetch: async () => undefined,
      refs: async () => ["main", "iteration_1"],
      browse: async (ref) => {
        lastBrowsed = ref;
        return { dir: "/the-one-folder", sha: `${ref}-sha`.padEnd(40, "0") };
      },
      withBrowseLock: async (fn) => fn(`/the-one-folder/as-of/${lastBrowsed}`),
      prepareRun: async (sha) => ({ dir: "/unused", sha }),
      prunePins: async () => 0,
      pin: async (ref) => `${ref}-sha`.padEnd(40, "0"),
      release: async () => undefined,
    };
    const lister: ScenarioLister = { list: async (dir) => (dir.endsWith("/iteration_1") ? [scenario("from-iteration-1")] : [scenario("from-main")]) };
    const a = adapter(catalog, lister);

    await a.browsable!.browse("main");
    await a.browsable!.browse("iteration_1");
    assert.deepEqual(await a.browsable!.targets(), [{ id: "from-iteration-1", title: null }]);
  });

  it("reads the folder withBrowseLock reports, not the (possibly stale) dir an earlier browse() returned", async () => {
    // Guards the fix for the race the review found: targets() must ask for the folder under the same
    // lock browse()/fetch() use, never trust a path cached from a Workspace that may since have been
    // checked out to something else.
    const catalog: CatalogWorkspaces = {
      fetch: async () => undefined,
      refs: async () => ["main"],
      browse: async () => ({ dir: "/stale-dir-from-browse", sha: "a".repeat(40) }),
      withBrowseLock: async (fn) => fn("/current-dir-under-lock"),
      prepareRun: async (sha) => ({ dir: "/unused", sha }),
      prunePins: async () => 0,
      pin: async () => "a".repeat(40),
      release: async () => undefined,
    };
    const lister: ScenarioLister = { list: async (dir) => [scenario(dir)] };
    const a = adapter(catalog, lister);

    await a.browsable!.browse("main");
    assert.deepEqual(await a.browsable!.targets(), [{ id: "/current-dir-under-lock", title: null }]);
  });

  it("turns a commit with no catalog into CatalogReadError, not a 500 for the API to swallow", async () => {
    const catalog: CatalogWorkspaces = {
      fetch: async () => undefined,
      refs: async () => ["main"],
      browse: async () => {
        throw new CatalogError("This commit has no orch.rc.json: it is not a perfect-qa catalog");
      },
      withBrowseLock: async (fn) => fn("/unused"),
      prepareRun: async (sha) => ({ dir: "/unused", sha }),
      prunePins: async () => 0,
      pin: async () => "a".repeat(40),
      release: async () => undefined,
    };
    const a = adapter(catalog, new FakeLister());
    await assert.rejects(a.browsable!.browse("main"), CatalogReadError);
  });

  it("turns an old branch (no `scenarios` command) into CatalogReadError too", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const tooOld: ScenarioLister = {
      list: async () => {
        throw new ScenariosUnsupportedError();
      },
    };
    const a = adapter(catalog, tooOld);
    await a.browsable!.browse("main");
    await assert.rejects(a.browsable!.targets(), CatalogReadError);
  });

  it("turns missing dependencies in the browsed folder into CatalogReadError too", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const noDeps: ScenarioLister = {
      list: async () => {
        throw new ScenarioListingError("dependencies are not installed");
      },
    };
    const a = adapter(catalog, noDeps);
    await a.browsable!.browse("main");
    await assert.rejects(a.browsable!.targets(), CatalogReadError);
  });
});
