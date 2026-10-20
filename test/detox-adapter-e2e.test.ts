import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { BakeContainers } from "../src/adapters/detox/bake-containers";
import { createDetoxAdapter } from "../src/adapters/detox/detox-adapter";
import { CliScenarioLister } from "../src/adapters/detox/scenario-lister";
import { AdapterRegistry } from "../src/core/adapter";
import { JobEnqueuer } from "../src/core/job-enqueuer";
import { JobScheduler } from "../src/core/job-scheduler";
import { JobService, type ProjectPolicy } from "../src/core/job-service";
import type { Database } from "../src/db/database";
import { openMemoryDatabase } from "../src/db/open-database";
import { SqliteJobStore } from "../src/db/sqlite-job-store";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { FileJobLog } from "../src/infra/file-job-log";
import { NodeProcessHost } from "../src/infra/node-process-host";
import { FakeCatalog, fakeCatalogDir } from "./helpers/fake-orchestrator";
import { scratchDir } from "./helpers/workspace";

const root = scratchDir();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class Containers implements BakeContainers {
  readonly stopped: string[] = [];
  async stopForJob(jobId: string): Promise<string[]> {
    this.stopped.push(jobId);
    return [];
  }
}

const heldResources = (db: Database): string[] => db.all("SELECT resource FROM locks").map((row) => row.resource as string);

// A test can fail between submitting a job and cancelling or awaiting it; whatever real process that
// left running must not outlive the file, so every scheduler is shut down (cancelled and drained) here.
const liveSchedulers: JobScheduler[] = [];
after(async () => {
  await Promise.all(liveSchedulers.map((scheduler) => scheduler.shutdown(5000)));
});

let counter = 0;
function rig(extraEnv: Record<string, string> = {}) {
  const dir = fakeCatalogDir(root, `e2e-${counter++}`);
  const catalog = new FakeCatalog(dir);
  const runner = new ExecCommandRunner();
  const containers = new Containers();
  const log = new FileJobLog(path.join(root, `logs-${counter}`));
  const env = () => ({ ...(process.env as Record<string, string>), ...extraEnv });
  const adapter = createDetoxAdapter({
    catalog,
    host: new NodeProcessHost(runner),
    lister: new CliScenarioLister(runner, env),
    containers,
    log,
    environment: env,
    killGraceMs: 300,
  });

  const db = openMemoryDatabase();
  const store = new SqliteJobStore(db);
  const adapters = new AdapterRegistry([adapter]);
  const scheduler = new JobScheduler(store, adapters);
  liveSchedulers.push(scheduler);
  const enqueuer = new JobEnqueuer(store, adapters, scheduler);
  const policy: ProjectPolicy = { id: adapter.id, allowedBranches: ["main"], defaultBranch: "main" };
  const jobs = new JobService([policy], adapters, enqueuer, scheduler, store);
  return { dir, catalog, db, store, scheduler, jobs, log, containers };
}

describe("Detox end to end (JobService -> scheduler -> real DetoxExecutor)", () => {
  it("submits, runs through the real process host, and ends succeeded with a log on disk and resources released", async () => {
    const { jobs, scheduler, db, catalog, log } = rig();

    const job = await jobs.submit({ project: "detox", target: "login" });
    assert.equal(job.status, "running");
    assert.deepEqual(heldResources(db), ["devices"]);

    await scheduler.idle();

    const finished = jobs.get(job.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.outcome, "success");
    assert.ok(finished.reportPath?.includes("scenario-run-"), finished.reportPath ?? "no report path");
    assert.deepEqual(catalog.prepared, [finished.sha]);
    assert.deepEqual(heldResources(db), [], "the devices lock must be free once the job is done");

    const logged = fs.readFileSync(log.pathOf(job.id), "utf8");
    assert.match(logged, /args=\["scenario","login","--mode","production"\]/);
  });

  it("a failing phase ends the job failed, with the executor's own error, and still releases its resources", async () => {
    const { jobs, scheduler, db } = rig({ FAKE_EXIT: "3" });

    const job = await jobs.submit({ project: "detox", target: "login" });
    await scheduler.idle();

    const finished = jobs.get(job.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /perfect-qa exited with code 3/);
    assert.deepEqual(heldResources(db), []);
  });

  it("cancelling a running job stops the real process and its build containers, and ends it cancelled", async () => {
    const { jobs, scheduler, db, containers } = rig({ FAKE_HANG: "1" });

    const job = await jobs.submit({ project: "detox", target: "login" });
    for (let i = 0; i < 200 && jobs.get(job.id).pid === null; i++) await sleep(25);
    assert.ok(jobs.get(job.id).pid, "the running process must have registered its pid before it can be cancelled");

    await jobs.cancel(job.id);
    await scheduler.idle();

    const finished = jobs.get(job.id);
    assert.equal(finished.status, "cancelled");
    // Once from DetoxExecutor.cancel(), once more from the cleanup the scheduler always runs afterwards.
    assert.deepEqual(containers.stopped, [job.id, job.id]);
    assert.deepEqual(heldResources(db), []);
  });

  it("refuses a scenario the pinned commit does not have, and the job fails without starting perfect-qa", async () => {
    const { jobs, scheduler, log } = rig({ FAKE_SCENARIOS: '["other"]' });

    const job = await jobs.submit({ project: "detox", target: "login" });
    await scheduler.idle();

    const finished = jobs.get(job.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.error ?? "", /Scenario "login" does not exist/);
    assert.ok(!fs.existsSync(log.pathOf(job.id)) || !fs.readFileSync(log.pathOf(job.id), "utf8").includes("args="), "perfect-qa must never have been started");
  });
});
