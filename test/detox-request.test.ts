import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DETOX_KINDS, detoxCliArgs, namesAScenario, planDetoxPhases, validateDetoxRequest } from "../src/adapters/detox/detox-request";
import { InvalidJobRequestError } from "../src/core/job-request";

const check = (kind: string, target: string, params: unknown = null) => validateDetoxRequest({ kind, target, params });
const refuses = (kind: string, target: string, params: unknown, message?: RegExp) =>
  assert.throws(() => check(kind, target, params), (error: unknown) => error instanceof InvalidJobRequestError && (message ? message.test(error.message) : true), JSON.stringify({ kind, target, params }));

describe("validateDetoxRequest", () => {
  it("knows the three kinds of job", () => {
    assert.deepEqual([...DETOX_KINDS], ["run", "build", "pipeline"]);
    refuses("deploy", "x", null, /kind must be one of/);
  });

  it("a run takes no params", () => {
    assert.deepEqual(check("run", "login"), {});
    assert.deepEqual(check("run", "login", {}), {});
    refuses("run", "login", { skipBuild: true }, /takes no params/);
    refuses("run", "login", "text", /params must be an object/);
    refuses("run", "login", ["a"], /params must be an object/);
  });

  it("a build takes a scenario or everything, with strict options", () => {
    assert.deepEqual(check("build", "all"), {});
    assert.deepEqual(check("build", "login", { skipBuild: true, noClone: false, only: ["kpmake", "kpfry", "kpmake"], wsHost: "10.0.0.5" }), {
      skipBuild: true,
      noClone: false,
      only: ["kpmake", "kpfry"],
      wsHost: "10.0.0.5",
    });
    refuses("build", "-x", null, /scenario name/);
    refuses("build", "a b", null, /scenario name/);
    refuses("build", "login", { out: "/etc" }, /unknown param "out"/);
    refuses("build", "login", { build: false }, /unknown param "build"/);
  });

  it("build options are typed and cannot be taken for flags or paths", () => {
    refuses("build", "all", { skipBuild: "yes" }, /true or false/);
    refuses("build", "all", { only: "kpmake" }, /list of 1 to 20/);
    refuses("build", "all", { only: [] }, /list of 1 to 20/);
    refuses("build", "all", { only: Array.from({ length: 21 }, (_, i) => `app${i}`) }, /list of 1 to 20/);
    for (const name of ["--force", "-x", "a b", "a;b", "../x", "a/b", "$(id)", "", "a".repeat(65), 5]) refuses("build", "all", { only: [name] }, /not a valid app name/);
    for (const host of ["--ws-port-base=1", "-h", "http://x", "a b", "a;b", "host:80", "", ".bad", "bad.", 5]) refuses("build", "all", { wsHost: host }, /host name or an IP/);
    assert.deepEqual(check("build", "all", { wsHost: "lab-host.example.com" }), { wsHost: "lab-host.example.com" });
  });

  it("a pipeline is named after its scope", () => {
    for (const scope of ["all", "batch", "step"]) assert.deepEqual(check("pipeline", scope), {});
    refuses("pipeline", "login", null, /target must be one of: all, batch, step/);
    assert.deepEqual(check("pipeline", "batch", { build: true, noClone: true }), { noClone: true, build: true });
    assert.deepEqual(check("pipeline", "all", { build: false }), { build: false });
    refuses("pipeline", "all", { build: false, noClone: true }, /make no sense with build: false/);
    refuses("pipeline", "all", { build: 1 }, /true or false/);
    refuses("pipeline", "all", { scope: "x" }, /unknown param "scope"/);
  });

  it("rejects a prototype key", () => {
    refuses("build", "all", JSON.parse('{"__proto__":{"x":1}}'), /unknown param/);
    refuses("run", "x", JSON.parse('{"constructor":1}'), /takes no params/);
  });
});

describe("planDetoxPhases", () => {
  it("names the phases of each kind", () => {
    assert.deepEqual(planDetoxPhases({ kind: "run", params: {} }), ["scenario"]);
    assert.deepEqual(planDetoxPhases({ kind: "build", params: {} }), ["build"]);
    assert.deepEqual(planDetoxPhases({ kind: "pipeline", params: {} }), ["build", "scenario"]);
    assert.deepEqual(planDetoxPhases({ kind: "pipeline", params: null }), ["build", "scenario"]);
    assert.deepEqual(planDetoxPhases({ kind: "pipeline", params: { build: false } }), ["scenario"]);
  });
});

describe("detoxCliArgs", () => {
  it("runs one scenario in production mode", () => {
    assert.deepEqual(detoxCliArgs({ kind: "run", target: "login", params: {} }, "scenario"), ["scenario", "login", "--mode", "production"]);
  });

  it("builds the APKs of one scenario or of everything", () => {
    assert.deepEqual(detoxCliArgs({ kind: "build", target: "login", params: {} }, "build"), ["generate-apk-production", "--scenario", "login"]);
    assert.deepEqual(detoxCliArgs({ kind: "build", target: "all", params: {} }, "build"), ["generate-apk-production"]);
    assert.deepEqual(
      detoxCliArgs({ kind: "build", target: "login", params: { wsHost: "10.0.0.5", skipBuild: true, noClone: true, only: ["kpmake", "kpfry"] } }, "build"),
      ["generate-apk-production", "--scenario", "login", "--ws-host", "10.0.0.5", "--skip-build", "--no-clone", "--only", "kpmake", "--only", "kpfry"],
    );
  });

  it("a pipeline builds then runs everything of its scope, as the nightly run does", () => {
    const all = { kind: "pipeline", target: "all", params: { noClone: true } };
    assert.deepEqual(detoxCliArgs(all, "build"), ["generate-apk-production", "--no-clone"]);
    assert.deepEqual(detoxCliArgs(all, "scenario"), ["scenario", "--all", "--mode", "production"]);
    const batch = { kind: "pipeline", target: "batch", params: {} };
    assert.deepEqual(detoxCliArgs(batch, "build"), ["generate-apk-production", "--kind", "batch"]);
    assert.deepEqual(detoxCliArgs(batch, "scenario"), ["scenario", "--all", "--mode", "production", "--kind", "batch"]);
  });

  it("never puts the options of a build on the scenario phase", () => {
    const job = { kind: "pipeline", target: "step", params: { wsHost: "10.0.0.5", only: ["kpmake"] } };
    assert.ok(!detoxCliArgs(job, "scenario").some((arg) => arg.startsWith("--ws") || arg === "--only"));
  });
});

describe("namesAScenario", () => {
  it("is true only when the target has to exist in the catalog", () => {
    assert.equal(namesAScenario({ kind: "run", target: "login" }), true);
    assert.equal(namesAScenario({ kind: "build", target: "login" }), true);
    assert.equal(namesAScenario({ kind: "build", target: "all" }), false);
    assert.equal(namesAScenario({ kind: "pipeline", target: "batch" }), false);
  });
});
