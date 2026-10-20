import { createApp } from "./app";
import { loadConfig } from "./config/load-config";
import { AdapterRegistry } from "./core/adapter";
import { JobScheduler } from "./core/job-scheduler";
import { ConfigError } from "./core/problems";
import { openDatabase } from "./db/open-database";
import { SqliteJobStore } from "./db/sqlite-job-store";
import { PinoNestLogger, createLogger } from "./logging/logger";

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env);

  const db = openDatabase(config.dataDir);
  const store = new SqliteJobStore(db);
  // Project adapters are registered here as they are built (the Detox one arrives with STA-38).
  const scheduler = new JobScheduler(store, new AdapterRegistry(), logger);
  await scheduler.reconcile();

  const app = await createApp(config, { jobs: store, onShutdown: [() => scheduler.stop(), () => db.close()] }, new PinoNestLogger(logger));
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
