import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule, type AppDependencies } from "./app.module";
import type { ServiceConfig } from "./config/service-config";

export async function createApp(
  config: ServiceConfig,
  dependencies: AppDependencies,
  logger: LoggerService | false = false,
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, dependencies), { logger });
  app.enableShutdownHooks();
  return app;
}
