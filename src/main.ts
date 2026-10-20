import * as fs from "node:fs";
import { createApp } from "./app";
import { loadConfig } from "./config/load-config";
import { ConfigError } from "./core/problems";
import { PinoNestLogger, createLogger } from "./logging/logger";

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig(process.env);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = await createApp(config, new PinoNestLogger(logger));
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
