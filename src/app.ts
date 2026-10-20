import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, type AppDependencies } from "./app.module";
import type { ServiceConfig } from "./config/service-config";

/** Largest request body accepted: job parameters are small, anything bigger is a mistake or an attack. */
export const MAX_BODY = "64kb";

export async function createApp(
  config: ServiceConfig,
  dependencies: AppDependencies,
  logger: LoggerService | false = false,
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, dependencies), { logger, bodyParser: false });
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: MAX_BODY });
  app.enableShutdownHooks();
  return app;
}
