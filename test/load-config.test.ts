import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/load-config";
import { ConfigError } from "../src/core/problems";
import { VALID_KEY, makeDir, scratchDir, validProjects } from "./helpers/workspace";

const root = scratchDir();
const dataDir = path.join(root, "data");
const runnerDir = makeDir(root, "e2e-detox-runner");
const infoDir = makeDir(root, "e2e-detox-info");

function envWith(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    E2E_SERVICE_API_KEY: VALID_KEY,
    E2E_SERVICE_DATA_DIR: dataDir,
    E2E_SERVICE_CONFIG: "/projects.json",
    E2E_DETOX_RUNNER_DIR: runnerDir,
    E2E_DETOX_INFO_DIR: infoDir,
    ...overrides,
  };
  for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
  return env;
}

const readProjects = (projects: unknown) => () => JSON.stringify(projects);

function problemsOf(env: NodeJS.ProcessEnv, projects: unknown = validProjects): readonly string[] {
  try {
    loadConfig(env, readProjects(projects));
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return error.problems;
  }
  assert.fail("expected the configuration to be rejected");
}

describe("loadConfig", () => {
  it("builds the configuration from a valid environment", () => {
    const config = loadConfig(envWith(), readProjects(validProjects));
    assert.deepEqual(config.apiKeys, [VALID_KEY]);
    assert.deepEqual(config.server, { host: "127.0.0.1", port: 8090 });
    assert.equal(config.dataDir, dataDir);
    assert.equal(config.projects[0]?.id, "detox");
    assert.equal(config.detox?.runnerDir, fs.realpathSync.native(runnerDir));
  });

  it("accepts a second key for rotation and a custom host and port", () => {
    const config = loadConfig(
      envWith({ E2E_SERVICE_API_KEY_NEXT: "the-next-key-0123456789", E2E_SERVICE_HOST: "0.0.0.0", E2E_SERVICE_PORT: "9100" }),
      readProjects(validProjects),
    );
    assert.equal(config.apiKeys.length, 2);
    assert.deepEqual(config.server, { host: "0.0.0.0", port: 9100 });
  });

  it("does not start without an API key", () => {
    const problems = problemsOf(envWith({ E2E_SERVICE_API_KEY: undefined }));
    assert.ok(problems.some((p) => p.includes("E2E_SERVICE_API_KEY is required")));
  });

  it("rejects short, blank and repeated keys", () => {
    assert.ok(problemsOf(envWith({ E2E_SERVICE_API_KEY: "short" })).some((p) => p.includes("at least 16")));
    assert.ok(problemsOf(envWith({ E2E_SERVICE_API_KEY: "   " })).some((p) => p.includes("is required")));
    assert.ok(problemsOf(envWith({ E2E_SERVICE_API_KEY_NEXT: VALID_KEY })).some((p) => p.includes("must differ")));
  });

  it("never repeats a key's value in its messages", () => {
    const secret = "short-secret";
    for (const problem of problemsOf(envWith({ E2E_SERVICE_API_KEY: secret }))) assert.ok(!problem.includes(secret));
  });

  it("rejects an invalid port and a relative data dir", () => {
    assert.ok(problemsOf(envWith({ E2E_SERVICE_PORT: "99999" })).some((p) => p.includes("E2E_SERVICE_PORT")));
    for (const port of ["80x", "0x50", "1e2", "-1", "0", "65536"]) {
      assert.ok(problemsOf(envWith({ E2E_SERVICE_PORT: port })).some((p) => p.includes("E2E_SERVICE_PORT")), port);
    }
    assert.ok(problemsOf(envWith({ E2E_SERVICE_DATA_DIR: "data" })).some((p) => p.includes("absolute")));
  });

  it("rejects an API key the Authorization header could not carry", () => {
    assert.ok(problemsOf(envWith({ E2E_SERVICE_API_KEY: "a key with spaces inside" })).some((p) => p.includes("printable ASCII")));
    assert.ok(problemsOf(envWith({ E2E_SERVICE_API_KEY: "clave-con-ñandú-123456" })).some((p) => p.includes("printable ASCII")));
  });

  it("needs the projects file, and it must be valid JSON with at least one project", () => {
    assert.ok(problemsOf(envWith({ E2E_SERVICE_CONFIG: undefined })).some((p) => p.includes("E2E_SERVICE_CONFIG is required")));
    assert.ok(problemsOf(envWith({ E2E_SERVICE_CONFIG: "relative.json" })).some((p) => p.includes("absolute")));
    assert.throws(() => loadConfig(envWith(), () => "{not json"), ConfigError);
    assert.ok(problemsOf(envWith(), { projects: {} }).some((p) => p.includes("at least one project")));
  });

  it("reads a real file, also when it starts with a byte order mark", () => {
    const file = path.join(root, "projects-bom.json");
    fs.writeFileSync(file, `﻿${JSON.stringify(validProjects)}`, "utf8");
    assert.equal(loadConfig(envWith({ E2E_SERVICE_CONFIG: file })).projects.length, 1);
  });

  it("does not echo the content of a file that is not the projects file", () => {
    const secret = "DB_PASSWORD=hunter2-very-secret";
    try {
      loadConfig(envWith(), () => secret);
      assert.fail("expected a ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes("hunter2"));
    }
  });

  it("says why a missing projects file cannot be read", () => {
    try {
      loadConfig(envWith({ E2E_SERVICE_CONFIG: path.join(root, "nope.json") }));
      assert.fail("expected a ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.includes("cannot be read (ENOENT)")));
    }
  });

  it("validates each project", () => {
    const bad = { projects: { Detox: { adapter: "nope", repo: "", allowedBranches: [], defaultBranch: "" } } };
    const problems = problemsOf(envWith(), bad);
    for (const part of ["the id must match", "adapter must be one of", "repo must be", "allowedBranches must be", "defaultBranch must be"]) {
      assert.ok(problems.some((p) => p.includes(part)), part);
    }
  });

  it("requires the default branch to be allowed", () => {
    const project = { ...validProjects.projects.detox, defaultBranch: "other" };
    assert.ok(problemsOf(envWith(), { projects: { detox: project } }).some((p) => p.includes("matched by allowedBranches")));
  });

  it("rejects a default branch that is not a safe branch name even if a pattern would match it", () => {
    const project = { ...validProjects.projects.detox, allowedBranches: ["feature/*"], defaultBranch: "feature/.." };
    assert.ok(problemsOf(envWith(), { projects: { detox: project } }).some((p) => p.includes("defaultBranch")));
  });

  it("rejects repo values that git would treat as an option or a custom transport", () => {
    for (const repo of ["--upload-pack=touch /tmp/x", "ext::sh -c touch% /tmp/x", "-oProxyCommand=x", "git@host", "ftp://host/x", "has space@host:x"]) {
      const project = { ...validProjects.projects.detox, repo };
      assert.ok(problemsOf(envWith(), { projects: { detox: project } }).some((p) => p.includes("repo must be")), repo);
    }
  });

  it("accepts the usual repo forms", () => {
    for (const repo of ["git@git.example.com:formos/x.git", "ssh://git@host/x.git", "https://host/x.git", "file:///srv/x.git"]) {
      const project = { ...validProjects.projects.detox, repo };
      assert.doesNotThrow(() => loadConfig(envWith(), readProjects({ projects: { detox: project } })), repo);
    }
  });

  it("rejects settings it does not know, so a typo is not silently ignored", () => {
    const project = { ...validProjects.projects.detox, allowedBranch: ["main"] };
    assert.ok(problemsOf(envWith(), { projects: { detox: project } }).some((p) => p.includes('unknown setting "allowedBranch"')));
  });

  it("rejects unsafe branch patterns", () => {
    const project = { ...validProjects.projects.detox, allowedBranches: ["--upload-pack=x"] };
    assert.ok(problemsOf(envWith(), { projects: { detox: project } }).some((p) => p.includes("allowedBranches must be")));
  });

  it("reports every problem at once", () => {
    const problems = problemsOf(envWith({ E2E_SERVICE_API_KEY: undefined, E2E_SERVICE_PORT: "0", E2E_SERVICE_DATA_DIR: undefined }));
    assert.ok(problems.length >= 3);
  });
});

describe("loadConfig: Detox folders", () => {
  it("requires both folders", () => {
    assert.ok(problemsOf(envWith({ E2E_DETOX_RUNNER_DIR: undefined })).some((p) => p.includes("E2E_DETOX_RUNNER_DIR is required")));
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: undefined })).some((p) => p.includes("E2E_DETOX_INFO_DIR is required")));
  });

  it("requires absolute paths to existing directories", () => {
    assert.ok(problemsOf(envWith({ E2E_DETOX_RUNNER_DIR: "relative/dir" })).some((p) => p.includes("absolute")));
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: path.join(root, "missing") })).some((p) => p.includes("cannot be used (ENOENT)")));
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "x");
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: file })).some((p) => p.includes("not a directory")));
  });

  it("refuses the same folder for both", () => {
    const problems = problemsOf(envWith({ E2E_DETOX_INFO_DIR: runnerDir }));
    assert.ok(problems.some((p) => p.includes("same folder")));
  });

  it("refuses the same folder written two ways", () => {
    const sneaky = `${runnerDir}${path.sep}..${path.sep}${path.basename(runnerDir)}${path.sep}.`; // not normalised
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: sneaky })).some((p) => p.includes("same folder")));
  });

  it("refuses a link to the other folder", (t) => {
    const link = path.join(root, "link-to-runner");
    try {
      fs.symlinkSync(runnerDir, link, "junction");
    } catch {
      t.skip("cannot create links on this machine");
      return;
    }
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: link })).some((p) => p.includes("same folder")));
  });

  it("refuses one folder inside the other, in both directions", () => {
    const inner = makeDir(runnerDir, "inner");
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: inner })).some((p) => p.includes("must not contain")));
    assert.ok(problemsOf(envWith({ E2E_DETOX_RUNNER_DIR: inner, E2E_DETOX_INFO_DIR: runnerDir })).some((p) => p.includes("must not contain")));
  });

  it("sees a folder nested under a name that starts with two dots", () => {
    const dotted = makeDir(runnerDir, "..cache");
    assert.ok(problemsOf(envWith({ E2E_DETOX_INFO_DIR: dotted })).some((p) => p.includes("must not contain")));
  });

  it("keeps the service data folder away from both worktrees, existing or not", () => {
    for (const dataDirectory of [path.join(runnerDir, "data"), path.join(infoDir, "deep", "data"), runnerDir, root]) {
      const problems = problemsOf(envWith({ E2E_SERVICE_DATA_DIR: dataDirectory }));
      assert.ok(problems.some((p) => p.includes("E2E_SERVICE_DATA_DIR")), dataDirectory);
    }
  });

  it("does not mistake a sibling with a shared name prefix for nesting", () => {
    const sibling = makeDir(root, `${path.basename(runnerDir)}-copy`);
    assert.doesNotThrow(() => loadConfig(envWith({ E2E_DETOX_INFO_DIR: sibling }), readProjects(validProjects)));
  });
});
