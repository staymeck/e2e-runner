import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { ServiceConfig } from "./config/service-config";

export async function createApp(config: ServiceConfig, logger: LoggerService | false = false): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { logger });
  app.enableShutdownHooks();
  return app;
}
