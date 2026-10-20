import type { DetoxConfig } from "../adapters/detox/detox-config";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface ProjectConfig {
  readonly id: string;
  readonly adapter: string;
  readonly repo: string;
  readonly allowedBranches: readonly string[];
  readonly defaultBranch: string;
}

export interface ServiceConfig {
  readonly server: ServerConfig;
  /** One key, or two while a key is being rotated. Never logged. */
  readonly apiKeys: readonly string[];
  readonly dataDir: string;
  readonly projects: readonly ProjectConfig[];
  /** Present only when a project uses the Detox adapter. */
  readonly detox: DetoxConfig | undefined;
}
