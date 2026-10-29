import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ArtifactAccessGuard } from "./api/artifact-access.guard";
import { AuthController } from "./api/auth.controller";
import { AuthGuard } from "./api/auth.guard";
import { DomainExceptionFilter } from "./api/domain-exception.filter";
import { HealthController } from "./api/health.controller";
import { JobsController } from "./api/jobs.controller";
import { ProjectsController } from "./api/projects.controller";
import { API_KEY_VERIFIER, ApiKeyVerifier } from "./auth/api-key-verifier";
import { ARTIFACT_TICKETS, ArtifactTickets } from "./auth/artifact-ticket";
import { STREAM_TICKETS, StreamTickets } from "./auth/stream-ticket";
import { WEB_SESSIONS, WebSessions } from "./auth/web-sessions";
import { WEB_USER_DIRECTORY, WebUserDirectory } from "./auth/web-users";
import type { ServiceConfig } from "./config/service-config";
import { DIAGNOSTICS, silentDiagnostics, type Diagnostics } from "./core/diagnostics";
import { JOB_LOG_READER, type JobLogReader } from "./core/job-log";
import { JOB_SERVICE, type JobService } from "./core/job-service";
import { LOG_STREAM_DETACH, LogStreamShutdown, type LogStreamDetachHolder } from "./lifecycle/log-stream-shutdown";
import { SHUTDOWN_CALLBACKS, ShutdownHooks, type ShutdownCallback } from "./lifecycle/shutdown-hooks";
import { parseWebhookSubscribers, WEBHOOK_SUBSCRIBERS, type WebhookSubscriberSecrets } from "./webhooks/subscribers";

export interface AppDependencies {
  readonly jobs: JobService;
  /** Read side of job logs, for GET .../log and the stream WebSocket. Defaults to an always-empty reader. */
  readonly logs?: JobLogReader;
  readonly diagnostics?: Diagnostics;
  /** Run in order when the app shuts down, e.g. to drain the scheduler and then close the database. */
  readonly onShutdown?: readonly ShutdownCallback[];
  /**
   * Built in `main.ts`, not here: `JobScheduler`'s `onFinished` hook (core, outside Nest) issues a
   * ticket the moment a job with a report finishes, so it must share this exact instance with the
   * `ArtifactAccessGuard` that later verifies one. Defaults to a fresh instance for a caller (e.g. a
   * test) that does not care about that wiring.
   */
  readonly artifactTickets?: ArtifactTickets;
  /**
   * Parsed once here (or supplied by a test that wants a fixed allowlist without touching
   * `process.env.E2E_WEBHOOK_SUBSCRIBERS`); `POST /v1/jobs` checks a submitted `webhookUrl` against
   * this same map (see `request-parsing.ts`). `postJobWebhookEvent` re-reads the env var itself at
   * send time (STA-35's own `onFinished` wiring in `main.ts`) — this is only for the submit-time check.
   */
  readonly webhookSubscribers?: ReadonlyMap<string, WebhookSubscriberSecrets>;
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
        { provide: ARTIFACT_TICKETS, useValue: dependencies.artifactTickets ?? new ArtifactTickets() },
        { provide: WEBHOOK_SUBSCRIBERS, useValue: dependencies.webhookSubscribers ?? parseWebhookSubscribers() },
        { provide: DIAGNOSTICS, useValue: dependencies.diagnostics ?? silentDiagnostics },
        { provide: SHUTDOWN_CALLBACKS, useValue: dependencies.onShutdown ?? [] },
        ShutdownHooks,
        { provide: LOG_STREAM_DETACH, useValue: {} as LogStreamDetachHolder },
        LogStreamShutdown,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        ArtifactAccessGuard,
      ],
    };
  }
}
