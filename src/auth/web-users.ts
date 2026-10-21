import { createHash, timingSafeEqual } from "node:crypto";
import type { WebRole, WebUserCredential } from "../config/service-config";

export const WEB_USER_DIRECTORY = Symbol("WEB_USER_DIRECTORY");

export interface WebUser {
  readonly username: string;
  readonly role: WebRole;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Never a real password: only ever compared against, to keep an unknown username's cost the same as a known one's. */
const DUMMY_PASSWORD_DIGEST = digest("no-such-user-dummy-password");

/**
 * Looks a username+password up against the fixed list from `E2E_WEB_USERS` — the same trust model
 * as the service's own API keys (plaintext in an env var, never logged), compared in constant time.
 */
export class WebUserDirectory {
  private readonly byUsername: ReadonlyMap<string, WebUserCredential>;

  constructor(users: readonly WebUserCredential[]) {
    this.byUsername = new Map(users.map((user) => [user.username, user]));
  }

  verify(username: string | undefined, password: string | undefined): WebUser | undefined {
    const found = username ? this.byUsername.get(username) : undefined;
    const candidate = digest(password ?? "");
    const expected = found ? digest(found.password) : DUMMY_PASSWORD_DIGEST;
    const matches = timingSafeEqual(candidate, expected);
    return found && matches ? { username: found.username, role: found.role } : undefined;
  }
}
