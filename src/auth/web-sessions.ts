import { randomBytes } from "node:crypto";
import type { WebUser } from "./web-users";

export const WEB_SESSIONS = Symbol("WEB_SESSIONS");

const TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface IssuedSession extends WebUser {
  readonly expiresAt: number;
}

/**
 * In-memory web login sessions — the same trust model as `StreamTickets`: a restart logs everyone
 * out harmlessly (just log in again), and nothing but this process ever needs to read one. Unlike a
 * stream ticket, a session is read many times (every request) until it expires or is revoked.
 */
export class WebSessions {
  private readonly sessions = new Map<string, IssuedSession>();

  constructor(private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS) {}

  issue(user: WebUser): string {
    this.sweep();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    this.sessions.set(token, { ...user, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  verify(token: string | undefined): WebUser | undefined {
    if (!token) return undefined;
    const found = this.sessions.get(token);
    if (!found) return undefined;
    if (found.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return { username: found.username, role: found.role };
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Drops expired sessions so a browser that never logs out cannot grow this map forever. */
  private sweep(): void {
    const now = Date.now();
    for (const [token, { expiresAt }] of this.sessions) {
      if (expiresAt < now) this.sessions.delete(token);
    }
  }
}
