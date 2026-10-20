import { Controller, Get } from "@nestjs/common";

@Controller("v1/health")
export class HealthController {
  @Get()
  health(): { ok: true } {
    return { ok: true };
  }
}
