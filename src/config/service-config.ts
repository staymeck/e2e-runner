import type { DetoxConfig } from "../adapters/detox/detox-config";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

/** `admin` can reach every role's area; `e2e-mobile`/`e2e-cypress` are scoped to their own. */
export type WebRole = "e2e-mobile" | "e2e-cypress" | "admin";

/** One entry of `E2E_WEB_USERS`. The password is plaintext, the same trust model as `apiKeys` below. */
export interface WebUserCredential {
  readonly username: string;
  readonly password: string;
  readonly role: WebRole;
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
  /** The web's login users, from `E2E_WEB_USERS`. Empty when unset: the service still works for
   * machine clients, just with the web's login screen disabled (every login attempt fails). */
  readonly webUsers: readonly WebUserCredential[];
  readonly dataDir: string;
  readonly projects: readonly ProjectConfig[];
  /** Present only when a project uses the Detox adapter. */
  readonly detox: DetoxConfig | undefined;
}
