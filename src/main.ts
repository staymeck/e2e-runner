import { createApp } from "./app";
import { loadConfig } from "./config/load-config";
import { AdapterRegistry } from "./core/adapter";
import { JobEnqueuer } from "./core/job-enqueuer";
import { JobScheduler } from "./core/job-scheduler";
import { JobService } from "./core/job-service";
import { ConfigError } from "./core/problems";
import { openDatabase } from "./db/open-database";
import { SqliteJobStore } from "./db/sqlite-job-store";
import { PinoNestLogger, createLogger } from "./logging/logger";

const SHUTDOWN_DRAIN_MS = 10_000;

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env);

  const db = openDatabase(config.dataDir);
  const store = new SqliteJobStore(db);
  // Project adapters are registered here as they are built (the Detox one arrives with STA-38).
  const adapters = new AdapterRegistry();
  const scheduler = new JobScheduler(store, adapters, logger);
  await scheduler.reconcile();

  const jobs = new JobService(config.projects, adapters, new JobEnqueuer(store, adapters, scheduler), scheduler, store);
  // Running jobs are cancelled and given a moment to end before the database goes away.
  const onShutdown = [() => scheduler.shutdown(SHUTDOWN_DRAIN_MS), () => db.close()];
  const app = await createApp(config, { jobs, diagnostics: logger, onShutdown }, new PinoNestLogger(logger));
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
