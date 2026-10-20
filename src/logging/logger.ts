import type { LoggerService } from "@nestjs/common";
import pino, { type Logger } from "pino";

export function createLogger(level = process.env.E2E_SERVICE_LOG_LEVEL || "info"): Logger {
  return pino({ level, base: { service: "e2e-runner" } });
}

/** Lets Nest write its own messages through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
