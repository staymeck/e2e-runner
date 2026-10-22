import { timingSafeEqual } from "node:crypto";
import type { WebRole, WebUserCredential } from "../config/service-config";
import { digest } from "./crypto";

export const WEB_USER_DIRECTORY = Symbol("WEB_USER_DIRECTORY");

export interface WebUser {
  readonly username: string;
  readonly role: WebRole;
}

interface IndexedUser extends WebUser {
  readonly passwordDigest: Buffer;
}

/** Never a real password: only ever compared against, to keep an unknown username's cost the same as a known one's. */
const DUMMY_PASSWORD_DIGEST = digest("no-such-user-dummy-password");

/**
 * Looks a username+password up against the fixed list from `E2E_WEB_USERS` — the same trust model
 * as the service's own API keys (plaintext in an env var, never logged), compared in constant time.
 * Every password is digested once here, at construction, never per call: digesting a real password
 * on a hit but reusing a precomputed buffer on a miss would itself leak which usernames exist, through
 * the extra hashing time (found during review; `ApiKeyVerifier` already avoided this the same way).
 */
export class WebUserDirectory {
  private readonly byUsername: ReadonlyMap<string, IndexedUser>;

  constructor(users: readonly WebUserCredential[]) {
    this.byUsername = new Map(users.map((user) => [user.username, { username: user.username, role: user.role, passwordDigest: digest(user.password) }]));
  }

  verify(username: string | undefined, password: string | undefined): WebUser | undefined {
    const found = username ? this.byUsername.get(username) : undefined;
    const candidate = digest(password ?? "");
    const expected = found ? found.passwordDigest : DUMMY_PASSWORD_DIGEST;
    const matches = timingSafeEqual(candidate, expected);
    return found && matches ? { username: found.username, role: found.role } : undefined;
  }
}
