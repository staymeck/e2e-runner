/** What the core needs to report about itself. pino's logger satisfies it as is. */
export interface Diagnostics {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export const DIAGNOSTICS = Symbol("DIAGNOSTICS");

export const silentDiagnostics: Diagnostics = { info: () => undefined, warn: () => undefined, error: () => undefined };
