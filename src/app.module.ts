import { DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api/api-key.guard";
import { HealthController } from "./api/health.controller";
import { API_KEY_VERIFIER, ApiKeyVerifier } from "./auth/api-key-verifier";
import type { ServiceConfig } from "./config/service-config";
import { JOB_STORE, type JobStore } from "./core/job-store";
import { SHUTDOWN_CALLBACKS, ShutdownHooks } from "./lifecycle/shutdown-hooks";

export interface AppDependencies {
  readonly jobs: JobStore;
  /** Run when the app shuts down, e.g. to close the database. */
  readonly onShutdown?: readonly (() => void)[];
}

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig, dependencies: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: API_KEY_VERIFIER, useValue: new ApiKeyVerifier(config.apiKeys) },
        { provide: JOB_STORE, useValue: dependencies.jobs },
        { provide: SHUTDOWN_CALLBACKS, useValue: dependencies.onShutdown ?? [] },
        ShutdownHooks,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}
