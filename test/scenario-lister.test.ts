import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CliScenarioLister, ScenarioListingError, ScenariosUnsupportedError, parseScenarioListing } from "../src/adapters/detox/scenario-lister";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { SERVICE_SECRET_NAMES, childEnvironment } from "../src/infra/safe-environment";
import { fakeCatalogDir } from "./helpers/fake-orchestrator";
import { makeDir, scratchDir } from "./helpers/workspace";

const root = scratchDir();
const lister = (env: Record<string, string> = {}) => new CliScenarioLister(new ExecCommandRunner(), () => ({ ...(process.env as Record<string, string>), ...env }));
const tempScenarioFolders = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("e2e-scenarios-"));

describe("parseScenarioListing", () => {
  const entry = { id: "a", kind: "step", title: "A", description: null, apps: ["kpmake"], appRefs: [{ name: "kpmake", branch: "iteration_1" }] };

  it("reads contract version 1 and ignores fields it does not know", () => {
    const [scenario] = parseScenarioListing({ contractVersion: 1, extra: true, scenarios: [{ ...entry, newField: 1 }] });
    assert.deepEqual(scenario, { id: "a", kind: "step", title: "A", description: null, apps: ["kpmake"], appRefs: [{ name: "kpmake", branch: "iteration_1" }] });
  });

  it("refuses a version it does not know instead of guessing", () => {
    for (const version of [0, 2, "1", undefined, null]) {
      assert.throws(() => parseScenarioListing({ contractVersion: version, scenarios: [] }), /Unsupported scenarios contract version/);
    }
    assert.throws(() => parseScenarioListing(null), ScenarioListingError);
  });

  it("refuses a document that is not shaped like the contract", () => {
    assert.throws(() => parseScenarioListing({ contractVersion: 1 }), /no scenarios list/);
    assert.throws(() => parseScenarioListing({ contractVersion: 1, scenarios: [{ ...entry, id: "" }] }), /no id/);
    assert.throws(() => parseScenarioListing({ contractVersion: 1, scenarios: [{ ...entry, kind: "weird" }] }), /unknown kind/);
    assert.throws(() => parseScenarioListing({ contractVersion: 1, scenarios: [{ ...entry, apps: [1] }] }), /list of text/);
    assert.throws(() => parseScenarioListing({ contractVersion: 1, scenarios: [null] }), ScenarioListingError);
  });

  it("accepts an empty catalog", () => {
    assert.deepEqual(parseScenarioListing({ contractVersion: 1, scenarios: [] }), []);
  });
});

describe("CliScenarioLister", () => {
  it("runs `perfect-qa scenarios --json` in the catalog folder and reads the file it writes, despite noise on stdout", async () => {
    const dir = fakeCatalogDir(root, "ok");
    const scenarios = await lister({ FAKE_SCENARIOS: '["checkout","login","pay"]' }).list(dir);
    assert.deepEqual(scenarios.map((s) => s.id), ["checkout", "login", "pay"]);
  });

  it("reports an old branch as unsupported, not as an empty catalog", async () => {
    const dir = fakeCatalogDir(root, "old");
    await assert.rejects(lister({ FAKE_OLD: "1" }).list(dir), ScenariosUnsupportedError);
  });

  it("reports dependencies that are not installed", async () => {
    const dir = makeDir(root, "no-deps");
    await assert.rejects(lister().list(dir), /dependencies are not installed/);
  });

  it("reports a listing that is not valid JSON", async () => {
    const dir = fakeCatalogDir(root, "broken");
    fs.writeFileSync(path.join(dir, "node_modules", "@perfect", "e2e-orchestrator", "bin", "perfect-qa.js"), 'require("node:fs").writeFileSync(process.argv[process.argv.indexOf("--out") + 1], "{nope");');
    await assert.rejects(lister().list(dir), /not valid JSON/);
  });

  it("reports a listing with a version it does not know", async () => {
    const dir = fakeCatalogDir(root, "future");
    fs.writeFileSync(
      path.join(dir, "node_modules", "@perfect", "e2e-orchestrator", "bin", "perfect-qa.js"),
      'require("node:fs").writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify({contractVersion: 2, scenarios: []}));',
    );
    await assert.rejects(lister().list(dir), /Unsupported scenarios contract version: 2/);
  });

  it("leaves no temporary folder behind, whatever happened", async () => {
    const before = tempScenarioFolders().length;
    await lister().list(fakeCatalogDir(root, "tidy-ok"));
    await assert.rejects(lister({ FAKE_OLD: "1" }).list(fakeCatalogDir(root, "tidy-old")));
    assert.equal(tempScenarioFolders().length, before);
  });
});

describe("CliScenarioLister: the service's own secret", () => {
  /**
   * `CommandRunner.run` with `minimalEnv: false` (what `list()` always uses) rebuilds its base
   * environment from this process's own `process.env`, not only from what `environment()` returns:
   * a key `environment()` merely omits is not thereby deleted, and comes back from that base. Only
   * naming it in `removeFromEnv` actually strips it. The real secret must be in this process's own
   * `process.env` for that to be exercised at all, so it is set and removed around the assertion.
   */
  it("never reaches the catalog's code, although it runs with minimalEnv: false", async () => {
    process.env.E2E_SERVICE_API_KEY = "must-not-leak-0123456789";
    try {
      const safe = new CliScenarioLister(new ExecCommandRunner(), childEnvironment, process.execPath, SERVICE_SECRET_NAMES);
      const [scenario] = await safe.list(fakeCatalogDir(root, "secret-removed"));
      assert.notEqual(scenario?.title, "secret-visible", "the service's own API key reached the catalog's code");
    } finally {
      delete process.env.E2E_SERVICE_API_KEY;
    }
  });

  it("leaks without removeFromEnv: this is why it must always be passed in production", async () => {
    process.env.E2E_SERVICE_API_KEY = "must-not-leak-0123456789";
    try {
      const unguarded = new CliScenarioLister(new ExecCommandRunner(), childEnvironment);
      const [scenario] = await unguarded.list(fakeCatalogDir(root, "secret-unguarded"));
      assert.equal(scenario?.title, "secret-visible", "expected the known gap to reproduce without removeFromEnv");
    } finally {
      delete process.env.E2E_SERVICE_API_KEY;
    }
  });
});
