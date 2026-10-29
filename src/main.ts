import * as path from "node:path";
import { DockerBakeContainers } from "./adapters/detox/bake-containers";
import { createDetoxCatalog } from "./adapters/detox/create-catalog";
import { DETOX_ADAPTER } from "./adapters/detox/detox-config";
import { createDetoxAdapter } from "./adapters/detox/detox-adapter";
import { NpmInstaller } from "./adapters/detox/dependency-installer";
import { CliApkStatusChecker } from "./adapters/detox/apk-status-checker";
import { CliDeviceChecker } from "./adapters/detox/device-checker";
import { CliScenarioLister } from "./adapters/detox/scenario-lister";
import { createApp } from "./app";
import { ArtifactTickets } from "./auth/artifact-ticket";
import { loadConfig } from "./config/load-config";
import { AdapterRegistry } from "./core/adapter";
import { JobEnqueuer } from "./core/job-enqueuer";
import { JobScheduler } from "./core/job-scheduler";
import { JobService } from "./core/job-service";
import { ConfigError } from "./core/problems";
import { openDatabase } from "./db/open-database";
import { SqliteJobStore } from "./db/sqlite-job-store";
import { ExecCommandRunner } from "./infra/exec-command-runner";
import { FileJobLog } from "./infra/file-job-log";
import { NodeProcessHost } from "./infra/node-process-host";
import { SERVICE_SECRET_NAMES, childEnvironment } from "./infra/safe-environment";
import { PinoNestLogger, createLogger } from "./logging/logger";
import { notifyOnFinish } from "./webhooks/notify-on-finish";

const JOB_LOGS_SUBDIR = "logs";

const SHUTDOWN_DRAIN_MS = 10_000;
const DEVICE_RECHECK_INTERVAL_MS = 15_000;
/** Once a day is plenty against ArtifactTickets' 30-day TTL — this only trims entries the lazy, issue-triggered sweep hasn't gotten to yet. */
const ARTIFACT_TICKET_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Where a webhook's own links.*, built from this, must point — never `config.server.host`/`port`
 * directly: those are what this process binds to, which a reverse proxy (or Docker) usually makes
 * unreachable from outside. Unset (the common case behind a path-prefixing proxy, same as
 * E2E_RUNNER_WEB_BASE for the web/STA-51), falls back to the bind address — correct only for a setup
 * with nothing in front of this service.
 */
function publicBaseUrl(host: string, port: number): string {
  return process.env.E2E_SERVICE_PUBLIC_URL?.trim() || `http://${host}:${port}`;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env);

  const db = openDatabase(config.dataDir);
  const store = new SqliteJobStore(db);
  const adapters = new AdapterRegistry();
  // One log store for every project's jobs: GET .../log and the stream WebSocket don't know or care which adapter wrote it.
  const jobLog = new FileJobLog(path.join(config.dataDir, JOB_LOGS_SUBDIR), logger);

  // Stops here, with every problem listed, if the two catalog folders are not two worktrees of the project's repository.
  const detoxProject = config.projects.find((project) => project.adapter === DETOX_ADAPTER);
  if (config.detox && detoxProject) {
    const runner = new ExecCommandRunner();
    const catalog = await createDetoxCatalog(config.detox, detoxProject, runner, new NpmInstaller(runner));
    adapters.register(
      createDetoxAdapter(
        {
          catalog,
          host: new NodeProcessHost(runner),
          lister: new CliScenarioLister(runner, childEnvironment, process.execPath, SERVICE_SECRET_NAMES),
          deviceLister: new CliDeviceChecker(runner, childEnvironment, process.execPath, SERVICE_SECRET_NAMES),
          apkStatusChecker: new CliApkStatusChecker(runner, childEnvironment, process.execPath, SERVICE_SECRET_NAMES),
          containers: new DockerBakeContainers(runner, logger),
          log: jobLog,
          environment: childEnvironment,
          diagnostics: logger,
        },
        detoxProject.id,
      ),
    );
  }
  // Shared with the API layer below: the scheduler issues a ticket the moment a finished job has a
  // report, and ArtifactAccessGuard later verifies the same ticket against the same instance.
  const artifactTickets = new ArtifactTickets(undefined, ARTIFACT_TICKET_SWEEP_INTERVAL_MS);
  // Nothing else wakes the scheduler for a job that canStart is blocking only on device connectivity
  // (no submission, no other job finishing) — this is what notices a device reconnecting on its own.
  const scheduler = new JobScheduler(store, adapters, logger, {
    recheckIntervalMs: DEVICE_RECHECK_INTERVAL_MS,
    onFinished: notifyOnFinish(artifactTickets, publicBaseUrl(config.server.host, config.server.port), logger),
  });
  await scheduler.reconcile();

  const jobs = new JobService(config.projects, adapters, new JobEnqueuer(store, adapters, scheduler), scheduler, store);
  // Running jobs are cancelled and given a moment to end before the database goes away.
  const onShutdown = [() => scheduler.shutdown(SHUTDOWN_DRAIN_MS), () => db.close()];
  const app = await createApp(config, { jobs, logs: jobLog, diagnostics: logger, onShutdown, artifactTickets }, new PinoNestLogger(logger));
  await app.listen(config.server.port, config.server.host);
  logger.info({ host: config.server.host, port: config.server.port, projects: config.projects.map((p) => p.id) }, "e2e-runner listening");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
});
