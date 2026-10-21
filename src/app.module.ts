import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuthController } from "./api/auth.controller";
import { AuthGuard } from "./api/auth.guard";
import { DomainExceptionFilter } from "./api/domain-exception.filter";
import { HealthController } from "./api/health.controller";
import { JobsController } from "./api/jobs.controller";
import { ProjectsController } from "./api/projects.controller";
import { API_KEY_VERIFIER, ApiKeyVerifier } from "./auth/api-key-verifier";
import { STREAM_TICKETS, StreamTickets } from "./auth/stream-ticket";
import { WEB_SESSIONS, WebSessions } from "./auth/web-sessions";
import { WEB_USER_DIRECTORY, WebUserDirectory } from "./auth/web-users";
import type { ServiceConfig } from "./config/service-config";
import { DIAGNOSTICS, silentDiagnostics, type Diagnostics } from "./core/diagnostics";
import { JOB_LOG_READER, type JobLogReader } from "./core/job-log";
import { JOB_SERVICE, type JobService } from "./core/job-service";
import { LOG_STREAM_DETACH, LogStreamShutdown, type LogStreamDetachHolder } from "./lifecycle/log-stream-shutdown";
import { SHUTDOWN_CALLBACKS, ShutdownHooks, type ShutdownCallback } from "./lifecycle/shutdown-hooks";

export interface AppDependencies {
  readonly jobs: JobService;
  /** Read side of job logs, for GET .../log and the stream WebSocket. Defaults to an always-empty reader. */
  readonly logs?: JobLogReader;
  readonly diagnostics?: Diagnostics;
  /** Run in order when the app shuts down, e.g. to drain the scheduler and then close the database. */
  readonly onShutdown?: readonly ShutdownCallback[];
}

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig, dependencies: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ProjectsController, JobsController],
      providers: [
        { provide: API_KEY_VERIFIER, useValue: new ApiKeyVerifier(config.apiKeys) },
        { provide: WEB_USER_DIRECTORY, useValue: new WebUserDirectory(config.webUsers) },
        { provide: WEB_SESSIONS, useValue: new WebSessions() },
        { provide: JOB_SERVICE, useValue: dependencies.jobs },
        { provide: JOB_LOG_READER, useValue: dependencies.logs ?? { read: () => ({ text: "", nextFrom: 0 }) } },
        { provide: STREAM_TICKETS, useValue: new StreamTickets() },
        { provide: DIAGNOSTICS, useValue: dependencies.diagnostics ?? silentDiagnostics },
        { provide: SHUTDOWN_CALLBACKS, useValue: dependencies.onShutdown ?? [] },
        ShutdownHooks,
        { provide: LOG_STREAM_DETACH, useValue: {} as LogStreamDetachHolder },
        LogStreamShutdown,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    };
  }
}
