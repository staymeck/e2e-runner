import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApkScenarioStatus, DeviceStatus } from "../src/core/adapter";
import type { Job } from "../src/core/job";
import { ApkStatusReadError, ApkStatusUnsupportedError, type ApkStatusLister } from "../src/adapters/detox/apk-status-checker";
import { CatalogError, type CatalogWorkspaces } from "../src/adapters/detox/catalog-workspaces";
import { DeviceListingError, DevicesUnsupportedError, type DeviceLister } from "../src/adapters/detox/device-checker";
import { createDetoxAdapter, DETOX_LOCKS, DETOX_PROJECT_ID } from "../src/adapters/detox/detox-adapter";
import { ScenarioListingError, ScenariosUnsupportedError, type ScenarioInfo, type ScenarioLister } from "../src/adapters/detox/scenario-lister";
import { CatalogReadError, InvalidJobRequestError, ScenarioNotReadyError } from "../src/core/job-request";
import { FakeCatalog } from "./helpers/fake-orchestrator";

const scenario = (id: string, overrides: Partial<ScenarioInfo> = {}): ScenarioInfo => ({ id, kind: "step", title: null, description: null, apps: [], appRefs: [], ...overrides });

class FakeLister implements ScenarioLister {
  readonly listedDirs: string[] = [];
  constructor(private readonly byDir: Record<string, readonly ScenarioInfo[]> = {}) {}
  async list(dir: string): Promise<readonly ScenarioInfo[]> {
    this.listedDirs.push(dir);
    return this.byDir[dir] ?? [];
  }
}

class FakeDeviceLister implements DeviceLister {
  constructor(private readonly connected: number) {}
  async list() {
    return Array.from({ length: this.connected }, (_, i) => ({ name: `device_${i}`, state: "connected" as const }));
  }
}

/** Unlike FakeDeviceLister, lets a test name each device's own state — to prove the "connected" filter
 * in canStart actually filters, not just counts whatever the lister returns. */
class MixedDeviceLister implements DeviceLister {
  constructor(private readonly devices: readonly DeviceStatus[]) {}
  async list() {
    return this.devices;
  }
}

class FakeApkStatusChecker implements ApkStatusLister {
  constructor(private readonly byScenario: Record<string, ApkScenarioStatus | null> = {}) {}
  async status(_dir: string, scenarioId: string): Promise<ApkScenarioStatus | null> {
    return Object.hasOwn(this.byScenario, scenarioId) ? this.byScenario[scenarioId]! : null;
  }
}

function apkRow(app: string, ready: boolean, branch = "main"): { app: string; branch: string; ready: boolean } {
  return { app, branch, ready };
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    seq: 1,
    id: "job-1",
    project: "detox",
    kind: "run",
    status: "queued",
    ref: "main",
    sha: "a".repeat(40),
    target: "login",
    params: {},
    locks: ["devices"],
    retryOf: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    outcome: null,
    error: null,
    pid: null,
    logPath: null,
    reportPath: null,
    phases: [],
    ...overrides,
  };
}

function adapter(catalog: CatalogWorkspaces, lister: ScenarioLister, deviceLister?: DeviceLister, apkStatusChecker?: ApkStatusLister) {
  return createDetoxAdapter({
    catalog,
    host: { start: () => { throw new Error("not used"); }, kill: () => undefined, commandLine: async () => undefined },
    lister,
    ...(deviceLister ? { deviceLister } : {}),
    ...(apkStatusChecker ? { apkStatusChecker } : {}),
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
    const lister = new FakeLister({ "/x": [scenario("login", { title: "Login" }), scenario("checkout")] });
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

describe("createDetoxAdapter: devices and canStart (STA-46)", () => {
  it("has neither devices nor canStart when no deviceLister was given — opting out of the gate entirely", () => {
    const a = adapter(new FakeCatalog("/x"), new FakeLister());
    assert.equal(a.devices, undefined);
    assert.equal(a.canStart, undefined);
  });

  it("devices.list() reads whatever the device lister reports for the browsing folder", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const a = adapter(catalog, new FakeLister(), new FakeDeviceLister(2));
    assert.deepEqual(await a.devices!.list(), [
      { name: "device_0", state: "connected" },
      { name: "device_1", state: "connected" },
    ]);
  });

  it("turns an old branch (no `devices` command) into CatalogReadError, same as targets() does for `scenarios`", async () => {
    const catalog = new FakeCatalog("/x");
    const tooOld: DeviceLister = {
      list: async () => {
        throw new DevicesUnsupportedError();
      },
    };
    const a = adapter(catalog, new FakeLister(), tooOld);
    await assert.rejects(a.devices!.list(), CatalogReadError);
  });

  it("turns a malformed or contract-version-mismatched listing into CatalogReadError too, not a bare 500", async () => {
    const catalog = new FakeCatalog("/x");
    const broken: DeviceLister = {
      list: async () => {
        throw new DeviceListingError("Unsupported devices contract version: 2 (this service reads 1)");
      },
    };
    const a = adapter(catalog, new FakeLister(), broken);
    await assert.rejects(a.devices!.list(), CatalogReadError);
  });

  it("is always ready for a build of everything or a pipeline: no single scenario's device count applies", async () => {
    const catalog = new FakeCatalog("/x");
    const a = adapter(catalog, new FakeLister(), new FakeDeviceLister(0));
    assert.deepEqual(await a.canStart!(fakeJob({ kind: "build", target: "all" })), { ready: true });
    assert.deepEqual(await a.canStart!(fakeJob({ kind: "pipeline", target: "all" })), { ready: true });
  });

  it("is always ready for a build of one specific scenario too — compiling never touches a device (STA-49)", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("login", { kind: "step", apps: ["kpmake", "kpfry"] })] });
    const a = adapter(catalog, lister, new FakeDeviceLister(0));
    await a.browsable!.browse("main");
    assert.deepEqual(await a.canStart!(fakeJob({ kind: "build", target: "login" })), { ready: true });
  });

  it("is ready when a step scenario's own app count is met by connected devices", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("login", { kind: "step", apps: ["kpmake", "kpfry"] })] });
    const a = adapter(catalog, lister, new FakeDeviceLister(2));
    await a.browsable!.browse("main");
    assert.deepEqual(await a.canStart!(fakeJob({ target: "login" })), { ready: true });
  });

  it("is not ready, with a visible reason, when fewer devices are connected than a step scenario needs", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("login", { kind: "step", apps: ["kpmake", "kpfry"] })] });
    const a = adapter(catalog, lister, new FakeDeviceLister(1));
    await a.browsable!.browse("main");
    const readiness = await a.canStart!(fakeJob({ target: "login" }));
    assert.equal(readiness.ready, false);
    assert.match(!readiness.ready ? readiness.reason : "", /1 de 2/);
  });

  it("counts only devices actually in the \"connected\" state, not every device the lister lists", async () => {
    // Three devices listed, but only one is genuinely usable — must not be mistaken for three connected.
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("login", { kind: "step", apps: ["kpmake", "kpfry"] })] });
    const devices = new MixedDeviceLister([
      { name: "device_a", state: "connected" },
      { name: "device_b", state: "disconnected" },
      { name: "device_c", state: "unauthorized" },
    ]);
    const a = adapter(catalog, lister, devices);
    await a.browsable!.browse("main");
    const readiness = await a.canStart!(fakeJob({ target: "login" }));
    assert.equal(readiness.ready, false);
    assert.match(!readiness.ready ? readiness.reason : "", /1 de 2/);
  });

  it("a batch scenario always needs exactly one device slot, however many apps it has", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("nightly", { kind: "batch", apps: ["kpmake", "kpfry", "kppack"] })] });
    const a = adapter(catalog, lister, new FakeDeviceLister(1));
    await a.browsable!.browse("main");
    assert.deepEqual(await a.canStart!(fakeJob({ target: "nightly" })), { ready: true });
  });

  it("a step scenario always needs at least one device slot, even with zero apps listed", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const lister = new FakeLister({ "/x": [scenario("edge-case", { kind: "step", apps: [] })] });
    const a = adapter(catalog, lister, new FakeDeviceLister(0));
    await a.browsable!.browse("main");
    const readiness = await a.canStart!(fakeJob({ target: "edge-case" }));
    assert.equal(readiness.ready, false);
    assert.match(!readiness.ready ? readiness.reason : "", /0 de 1/);
  });

  it("is ready when the job's target is not a scenario the browsing folder currently lists (unknown here, not a reason to block)", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const a = adapter(catalog, new FakeLister({ "/x": [] }), new FakeDeviceLister(0));
    await a.browsable!.browse("main");
    assert.deepEqual(await a.canStart!(fakeJob({ target: "ghost" })), { ready: true });
  });
});

describe("createDetoxAdapter: apkStatus and checkReady (STA-48)", () => {
  it("has neither apkStatus nor checkReady when no apkStatusChecker was given — opting out entirely", () => {
    const a = adapter(new FakeCatalog("/x"), new FakeLister());
    assert.equal(a.apkStatus, undefined);
    assert.equal(a.checkReady, undefined);
  });

  it("apkStatus.status() reads whatever the checker reports for the browsing folder", async () => {
    const catalog = new FakeCatalog("/x", { main: "a".repeat(40) });
    const checker = new FakeApkStatusChecker({ login: { scenarioId: "login", kind: "step", apps: [apkRow("kpmake", true)] } });
    const a = adapter(catalog, new FakeLister(), undefined, checker);
    assert.deepEqual(await a.apkStatus!.status("login"), { scenarioId: "login", kind: "step", apps: [apkRow("kpmake", true)] });
  });

  it("apkStatus.status() turns an old branch (no apk-status command) into CatalogReadError, same as devices does", async () => {
    const catalog = new FakeCatalog("/x");
    const tooOld: ApkStatusLister = {
      status: async () => {
        throw new ApkStatusUnsupportedError();
      },
    };
    const a = adapter(catalog, new FakeLister(), undefined, tooOld);
    await assert.rejects(a.apkStatus!.status("login"), CatalogReadError);
  });

  it("apkStatus.status() turns a malformed or contract-version-mismatched listing into CatalogReadError too", async () => {
    const catalog = new FakeCatalog("/x");
    const broken: ApkStatusLister = {
      status: async () => {
        throw new ApkStatusReadError("Unsupported apk-status contract version: 2 (this service reads 1)");
      },
    };
    const a = adapter(catalog, new FakeLister(), undefined, broken);
    await assert.rejects(a.apkStatus!.status("login"), CatalogReadError);
  });

  it("checkReady never rejects a build or a pipeline — only \"run\" assumes its scenario is already built", async () => {
    const catalog = new FakeCatalog("/x");
    const checker = new FakeApkStatusChecker({ login: { scenarioId: "login", kind: "step", apps: [apkRow("kpmake", false)] } });
    const a = adapter(catalog, new FakeLister(), undefined, checker);
    await a.checkReady!({ kind: "build", target: "login", params: null });
    await a.checkReady!({ kind: "pipeline", target: "all", params: null });
    // Neither call above threw; that is the assertion.
  });

  it("checkReady resolves for a \"run\" whose scenario has every app ready", async () => {
    const catalog = new FakeCatalog("/x");
    const checker = new FakeApkStatusChecker({ login: { scenarioId: "login", kind: "step", apps: [apkRow("kpmake", true), apkRow("kpfry", true)] } });
    const a = adapter(catalog, new FakeLister(), undefined, checker);
    await a.checkReady!({ kind: "run", target: "login", params: null });
  });

  it("checkReady rejects a \"run\" whose scenario has an app that is not built, naming it", async () => {
    const catalog = new FakeCatalog("/x");
    const checker = new FakeApkStatusChecker({ login: { scenarioId: "login", kind: "step", apps: [apkRow("kpmake", true), apkRow("kpfry", false)] } });
    const a = adapter(catalog, new FakeLister(), undefined, checker);
    await assert.rejects(a.checkReady!({ kind: "run", target: "login", params: null }), (error: unknown) => {
      assert.ok(error instanceof ScenarioNotReadyError);
      assert.deepEqual(error.notReady, ["kpfry"]);
      return true;
    });
  });

  it("checkReady fails open when the status read itself fails (an old branch, a missing orchestrator)", async () => {
    const catalog = new FakeCatalog("/x");
    const broken: ApkStatusLister = {
      status: async () => {
        throw new ApkStatusUnsupportedError();
      },
    };
    const a = adapter(catalog, new FakeLister(), undefined, broken);
    await a.checkReady!({ kind: "run", target: "login", params: null });
  });

  it("checkReady fails open when the scenario is unknown to apk-status — the executor's own check at the real commit is what matters", async () => {
    const catalog = new FakeCatalog("/x");
    const checker = new FakeApkStatusChecker({});
    const a = adapter(catalog, new FakeLister(), undefined, checker);
    await a.checkReady!({ kind: "run", target: "ghost", params: null });
  });
});
