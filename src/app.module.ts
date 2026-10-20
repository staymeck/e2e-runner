import { DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api/api-key.guard";
import { DomainExceptionFilter } from "./api/domain-exception.filter";
import { HealthController } from "./api/health.controller";
import { JobsController } from "./api/jobs.controller";
import { ProjectsController } from "./api/projects.controller";
import { API_KEY_VERIFIER, ApiKeyVerifier } from "./auth/api-key-verifier";
import type { ServiceConfig } from "./config/service-config";
import { DIAGNOSTICS, silentDiagnostics, type Diagnostics } from "./core/diagnostics";
import { JOB_SERVICE, type JobService } from "./core/job-service";
import { SHUTDOWN_CALLBACKS, ShutdownHooks, type ShutdownCallback } from "./lifecycle/shutdown-hooks";

export interface AppDependencies {
  readonly jobs: JobService;
  readonly diagnostics?: Diagnostics;
  /** Run in order when the app shuts down, e.g. to drain the scheduler and then close the database. */
  readonly onShutdown?: readonly ShutdownCallback[];
}

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig, dependencies: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProjectsController, JobsController],
      providers: [
        { provide: API_KEY_VERIFIER, useValue: new ApiKeyVerifier(config.apiKeys) },
        { provide: JOB_SERVICE, useValue: dependencies.jobs },
        { provide: DIAGNOSTICS, useValue: dependencies.diagnostics ?? silentDiagnostics },
        { provide: SHUTDOWN_CALLBACKS, useValue: dependencies.onShutdown ?? [] },
        ShutdownHooks,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    };
  }
}
