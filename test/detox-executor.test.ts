import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import type { BakeContainers } from "../src/adapters/detox/bake-containers";
import { DetoxExecutor } from "../src/adapters/detox/detox-executor";
import { CliScenarioLister } from "../src/adapters/detox/scenario-lister";
import type { PhaseRun, RunContext } from "../src/core/adapter";
import type { Job } from "../src/core/job";
import type { JobLog } from "../src/core/job-log";
import type { ProcessHost, RunningProcess, StartOptions } from "../src/core/process-host";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { NodeProcessHost } from "../src/infra/node-process-host";
import { sleep } from "./helpers/fake-adapter";
import { FakeCatalog, fakeCatalogDir } from "./helpers/fake-orchestrator";
import { scratchDir } from "./helpers/workspace";

const root = scratchDir();
const SHA = "c".repeat(40);

class Log implements JobLog {
  text = "";
  append(_jobId: string, chunk: string): void {
    this.text += chunk;
  }
}

class Containers implements BakeContainers {
  readonly stopped: string[] = [];
  async stopForJob(jobId: string): Promise<string[]> {
    this.stopped.push(jobId);
    return [];
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    seq: 1, id: "job-1", project: "detox", kind: "run", status: "running", ref: "main", sha: SHA, target: "login", params: {}, locks: ["devices"],
    retryOf: null, createdAt: "", startedAt: "", finishedAt: null, cancelRequestedAt: null, outcome: null, error: null, pid: null, logPath: null,
    reportPath: null, webhookUrl: null, phases: [], ...overrides,
  };
}

const phase = (j: Job, name = "scenario", position = 0): PhaseRun => ({ job: j, name, position });

function context(signal = new AbortController().signal) {
  const pids: number[] = [];
  const ctx: RunContext = { signal, registerProcess: (pid) => pids.push(pid) };
  return { ctx, pids };
}

let counter = 0;
function rig(extraEnv: Record<string, string> = {}, killGraceMs = 300) {
  const dir = fakeCatalogDir(root, `catalog-${counter++}`);
  const catalog = new FakeCatalog(dir);
  const log = new Log();
  const containers = new Containers();
  const runner = new ExecCommandRunner();
  const env = () => ({ ...(process.env as Record<string, string>), E2E_SERVICE_API_KEY: "must-not-leak-0123456789", ...extraEnv });
  const host = new NodeProcessHost(runner);
  const executor = new DetoxExecutor({
    catalog,
    host,
    lister: new CliScenarioLister(runner, () => env()),
    containers,
    log,
    environment: () => {
      const { E2E_SERVICE_API_KEY: _removedByTheAdapter, ...rest } = env();
      void _removedByTheAdapter;
      return rest;
    },
    killGraceMs,
  });
  return { dir, catalog, log, containers, executor, host };
}

describe("DetoxExecutor.plan", () => {
  it("names the phases by kind", () => {
    const { executor } = rig();
    assert.deepEqual(executor.plan({ kind: "run", target: "x", params: {} }), ["scenario"]);
    assert.deepEqual(executor.plan({ kind: "pipeline", target: "all", params: {} }), ["build", "scenario"]);
  });
});

describe("DetoxExecutor.run", () => {
  it("runs the scenario in the prepared run folder at the pinned commit and reports where its report went", async () => {
    const { executor, catalog, log, dir } = rig();
    const { ctx, pids } = context();
    const result = await executor.run(phase(job()), ctx);

    assert.deepEqual(catalog.prepared, [SHA]);
    assert.equal(result.outcome, "success");
    assert.equal(result.exitCode, 0);
    assert.ok(result.reportPath?.startsWith(dir) && /scenario-run-/.test(result.reportPath), result.reportPath);
    assert.equal(pids.length, 1, "the process id was registered, for crash cleanup");
    assert.match(log.text, /args=\["scenario","login","--mode","production"\]/);
    assert.match(log.text, /job=job-1 phase=scenario/);
    assert.ok(log.text.includes(`cwd=${fs.realpathSync.native(dir)}`) || log.text.toLowerCase().includes(`cwd=${dir.toLowerCase()}`), log.text);
    assert.match(log.text, /a line on stderr/, "stderr is part of the log");
  });

  it("never hands the service's own settings to the catalog's code", async () => {
    const { executor, log } = rig();
    await executor.run(phase(job()), context().ctx);
    assert.match(log.text, /service-key-visible=false/);
  });

  it("tells the catalog where it is, like the orchestrator's own API did", async () => {
    const { executor, log, dir } = rig();
    await executor.run(phase(job()), context().ctx);
    const normalized = log.text.replace(/\\/g, "/").toLowerCase();
    assert.ok(normalized.includes(`catalog=${dir.replace(/\\/g, "/").toLowerCase()}`));
    assert.ok(normalized.includes("node_modules/@perfect/e2e-orchestrator"));
  });

  it("a non-zero exit is a failure that says so, and keeps the report", async () => {
    const { executor } = rig({ FAKE_EXIT: "3" });
    const result = await executor.run(phase(job()), context().ctx);
    assert.deepEqual([result.outcome, result.exitCode, result.error], ["failure", 3, "perfect-qa exited with code 3"]);
    assert.ok(result.reportPath);
  });

  it("a clean exit with skipped scenarios is a warning", async () => {
    const { executor } = rig({ FAKE_SKIPPED: "2" });
    assert.equal((await executor.run(phase(job()), context().ctx)).outcome, "warning");
  });

  it("does not look for a report after a build", async () => {
    const { executor } = rig();
    const result = await executor.run(phase(job({ kind: "build", target: "all" }), "build"), context().ctx);
    assert.equal(result.reportPath, undefined);
    assert.equal(result.outcome, "success");
  });

  it("refuses a scenario the commit does not have, without starting it", async () => {
    const { executor, log } = rig({ FAKE_SCENARIOS: '["other"]' });
    const result = await executor.run(phase(job({ target: "login" })), context().ctx);
    assert.equal(result.outcome, "failure");
    assert.match(result.error ?? "", /Scenario "login" does not exist in commit cccccccccccc/);
    assert.ok(!log.text.includes("args="), "nothing was started");
  });

  it("explains a catalog too old to be listed", async () => {
    const { executor } = rig({ FAKE_OLD: "1" });
    const result = await executor.run(phase(job()), context().ctx);
    assert.match(result.error ?? "", /branch is too old to be listed/);
  });

  it("a build of everything and a pipeline need no scenario check", async () => {
    const { executor, log } = rig({ FAKE_OLD: "1" }); // listing would fail: it must not be asked
    const result = await executor.run(phase(job({ kind: "pipeline", target: "all", params: {} }), "build"), context().ctx);
    assert.equal(result.outcome, "success");
    assert.match(log.text, /args=\["generate-apk-production","--out","e2e-runner-apk-plan"\]/);
  });

  it("sets ORCH_APK_PRODUCTION_DIR for both the build phase and the scenario (run) phase, not just one", async () => {
    const { executor, log } = rig({ FAKE_OLD: "1" });
    const pipeline = job({ kind: "pipeline", target: "all", params: {} });
    await executor.run(phase(pipeline, "build", 0), context().ctx);
    await executor.run(phase(pipeline, "scenario", 1), context().ctx);
    const occurrences = log.text.match(/apk-production-dir=e2e-runner-apk-plan/g) ?? [];
    assert.equal(occurrences.length, 2, "both the build phase and the run phase must read/write the same job-scoped plan folder, never the catalog's real apk-production/");
  });

  it("prepares the catalog once per job, not once per phase", async () => {
    const { executor, catalog } = rig();
    const pipeline = job({ kind: "pipeline", target: "all", params: {} });
    await executor.run(phase(pipeline, "build", 0), context().ctx);
    await executor.run(phase(pipeline, "scenario", 1), context().ctx);
    assert.deepEqual(catalog.prepared, [SHA]);
  });

  it("reports a catalog that could not be prepared", async () => {
    const { executor, catalog, log } = rig();
    catalog.prepareError = new Error("npm ci failed");
    const result = await executor.run(phase(job()), context().ctx);
    assert.equal(result.outcome, "failure");
    assert.match(result.error ?? "", /Could not prepare the catalog at cccccccccccc: npm ci failed/);
    assert.match(log.text, /npm ci failed/);
  });

  it("reports a program that cannot be started", async () => {
    const { executor, host } = rig();
    const failing: ProcessHost = {
      start: (_c: string, _a: readonly string[], _o: StartOptions): RunningProcess => ({ pid: undefined, exit: Promise.resolve({ code: null, signal: null, spawnError: "ENOENT" }) }),
      kill: host.kill.bind(host),
      commandLine: host.commandLine.bind(host),
    };
    const broken = new DetoxExecutor({ catalog: new FakeCatalog(rig().dir), host: failing, lister: { list: async () => [{ id: "login", kind: "step", title: null, description: null, apps: [], appRefs: [] }] }, containers: new Containers(), log: new Log(), environment: () => ({}) });
    const result = await broken.run(phase(job()), context().ctx);
    assert.match(result.error ?? "", /Could not start perfect-qa: ENOENT/);
    void executor;
  });

  it("does not start anything for a job that was cancelled before it began", async () => {
    const { executor, catalog, log } = rig();
    const controller = new AbortController();
    controller.abort();
    const result = await executor.run(phase(job()), context(controller.signal).ctx);
    assert.equal(result.outcome, "failure");
    assert.deepEqual(catalog.prepared, []);
    assert.equal(log.text, "");
  });
});

describe("DetoxExecutor: stopping a run", () => {
  it("terminates the process when the signal aborts, and lets it finish its report", async () => {
    const { executor, log } = rig({ FAKE_HANG: "1" });
    const controller = new AbortController();
    const running = executor.run(phase(job()), context(controller.signal).ctx);
    for (let i = 0; i < 100 && !log.text.includes("hanging"); i++) await sleep(50);
    assert.match(log.text, /hanging/);
    controller.abort();
    const result = await running;
    assert.match(log.text, /got SIGTERM/);
    assert.equal(result.outcome, "failure");
    assert.equal(result.error, "Cancelled");
  });

  it("cancel() sends SIGTERM and stops the job's build containers", async () => {
    const { executor, log, containers } = rig({ FAKE_HANG: "1" });
    const running = executor.run(phase(job()), context().ctx);
    for (let i = 0; i < 100 && !log.text.includes("hanging"); i++) await sleep(50);
    await executor.cancel("job-1");
    const result = await running;
    assert.match(log.text, /got SIGTERM/);
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(containers.stopped, ["job-1"]);
  });

  it("kills a process that ignores SIGTERM once the grace period is over", async () => {
    const { executor, log } = rig({ FAKE_HANG: "1", FAKE_IGNORE_TERM: "1" }, 200);
    const running = executor.run(phase(job()), context().ctx);
    for (let i = 0; i < 100 && !log.text.includes("hanging"); i++) await sleep(50);
    await executor.cancel("job-1");
    const result = await Promise.race([running, sleep(10_000).then(() => "still running" as const)]);
    assert.notEqual(result, "still running", "the grace timer must escalate to SIGKILL");
    assert.match(log.text, /ignoring SIGTERM/);
  });

  it("cancel() is harmless when nothing is running", async () => {
    const { executor, containers } = rig();
    await executor.cancel("never-started");
    assert.deepEqual(containers.stopped, ["never-started"]);
  });
});

describe("DetoxExecutor.cleanup", () => {
  it("kills what is left of the job's process and stops its containers", async () => {
    const { executor, log, containers } = rig({ FAKE_HANG: "1", FAKE_IGNORE_TERM: "1" });
    const running = executor.run(phase(job()), context().ctx);
    for (let i = 0; i < 100 && !log.text.includes("hanging"); i++) await sleep(50);
    await executor.cleanup("job-1", null);
    const result = await Promise.race([running, sleep(10_000).then(() => "still running" as const)]);
    assert.notEqual(result, "still running");
    assert.deepEqual(containers.stopped, ["job-1"]);
  });

  it("is idempotent and safe for a job it never saw", async () => {
    const { executor, containers } = rig();
    await executor.cleanup("ghost", null);
    await executor.cleanup("ghost", null);
    assert.deepEqual(containers.stopped, ["ghost", "ghost"]);
  });

  it("after a crash, kills the registered process only if it still is a perfect-qa run", async () => {
    const killed: Array<[number, string]> = [];
    const commands = new Map<number, string | undefined>([[111, "node /srv/catalog/node_modules/@perfect/e2e-orchestrator/bin/perfect-qa.js scenario login"], [222, "/usr/bin/postgres -D /data"], [333, undefined]]);
    const host: ProcessHost = {
      start: () => {
        throw new Error("not used");
      },
      kill: (pid, signal) => void killed.push([pid, signal]),
      commandLine: async (pid) => commands.get(pid),
    };
    const executor = new DetoxExecutor({ catalog: new FakeCatalog("/x"), host, lister: { list: async () => [] }, containers: new Containers(), log: new Log(), environment: () => ({}) });
    await executor.cleanup("a", 111);
    await executor.cleanup("b", 222); // the id was reused by something else
    await executor.cleanup("c", 333); // cannot be told: left alone
    assert.deepEqual(killed, [[111, "SIGKILL"]]);
  });
});
