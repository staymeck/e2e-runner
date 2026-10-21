import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, type AppDependencies } from "./app.module";
import { attachLogStream } from "./api/log-stream-server";
import { STREAM_TICKETS, type StreamTickets } from "./auth/stream-ticket";
import type { ServiceConfig } from "./config/service-config";
import { JOB_LOG_READER, type JobLogReader } from "./core/job-log";
import { JOB_SERVICE, type JobService } from "./core/job-service";
import { LOG_STREAM_DETACH, type LogStreamDetachHolder } from "./lifecycle/log-stream-shutdown";

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

  // Outside Nest's own request pipeline (see log-stream-server.ts for why): attached straight to the
  // same HTTP server.
  const detach = attachLogStream(app.getHttpServer(), {
    jobs: app.get<JobService>(JOB_SERVICE),
    logs: app.get<JobLogReader>(JOB_LOG_READER),
    tickets: app.get<StreamTickets>(STREAM_TICKETS),
  });
  // Not a plain `app.close` wrapper, and not the HTTP server's own "close" event: Nest wraps every
  // public method of the app (close included) in a proxy that re-reads the current method by name
  // each time it runs, so capturing "the original close" with `app.close.bind(app)` and calling it
  // from inside a replacement recurses into that same replacement forever. `beforeApplicationShutdown`
  // is the supported hook for this: it runs before Nest's HTTP adapter force-destroys open sockets
  // (upgraded WebSockets included), in time for them to still close cleanly.
  app.get<LogStreamDetachHolder>(LOG_STREAM_DETACH).detach = detach;

  return app;
}
