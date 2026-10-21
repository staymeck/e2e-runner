import * as path from "node:path";
import { DockerBakeContainers } from "./adapters/detox/bake-containers";
import { createDetoxCatalog } from "./adapters/detox/create-catalog";
import { DETOX_ADAPTER } from "./adapters/detox/detox-config";
import { createDetoxAdapter } from "./adapters/detox/detox-adapter";
import { NpmInstaller } from "./adapters/detox/dependency-installer";
import { CliScenarioLister } from "./adapters/detox/scenario-lister";
import { createApp } from "./app";
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

const JOB_LOGS_SUBDIR = "logs";

const SHUTDOWN_DRAIN_MS = 10_000;

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
          containers: new DockerBakeContainers(runner, logger),
          log: jobLog,
          environment: childEnvironment,
          diagnostics: logger,
        },
        detoxProject.id,
      ),
    );
  }
  const scheduler = new JobScheduler(store, adapters, logger);
  await scheduler.reconcile();

  const jobs = new JobService(config.projects, adapters, new JobEnqueuer(store, adapters, scheduler), scheduler, store);
  // Running jobs are cancelled and given a moment to end before the database goes away.
  const onShutdown = [() => scheduler.shutdown(SHUTDOWN_DRAIN_MS), () => db.close()];
  const app = await createApp(config, { jobs, logs: jobLog, diagnostics: logger, onShutdown }, new PinoNestLogger(logger));
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
