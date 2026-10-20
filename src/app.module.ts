import { DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api/api-key.guard";
import { HealthController } from "./api/health.controller";
import { API_KEY_VERIFIER, ApiKeyVerifier } from "./auth/api-key-verifier";
import { SERVICE_CONFIG } from "./config/tokens";
import type { ServiceConfig } from "./config/service-config";

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_CONFIG, useValue: config },
        { provide: API_KEY_VERIFIER, useValue: new ApiKeyVerifier(config.apiKeys) },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}
