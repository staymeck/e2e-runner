import { createApp } from "./app";
import { loadConfig } from "./config/load-config";
import { ConfigError } from "./core/problems";
import { openDatabase } from "./db/open-database";
import { SqliteJobStore } from "./db/sqlite-job-store";
import { PinoNestLogger, createLogger } from "./logging/logger";

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env);

  const db = openDatabase(config.dataDir);
  process.once("exit", () => db.close());

  const app = await createApp(config, { jobs: new SqliteJobStore(db) }, new PinoNestLogger(logger));
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
