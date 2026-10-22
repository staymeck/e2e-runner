import { randomBytes } from "node:crypto";
import type { WebUser } from "./web-users";

export const WEB_SESSIONS = Symbol("WEB_SESSIONS");

const TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A username logging in past this many live sessions drops its own oldest ones first. */
export const MAX_SESSIONS_PER_USER = 5;

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

  constructor(
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly maxPerUser: number = MAX_SESSIONS_PER_USER,
  ) {}

  issue(user: WebUser): string {
    this.sweep();
    this.evictOldestFor(user.username);
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

  /**
   * Drops this username's oldest sessions, leaving room for one more within `maxPerUser` — so a
   * single leaked credential, or a script logging in repeatedly, cannot grow this map forever just
   * by logging in again and again; `sweep()` alone only ever removes already-expired entries.
   * `Map` iterates in insertion order, so this username's own entries are already oldest-first.
   */
  private evictOldestFor(username: string): void {
    const tokens: string[] = [];
    for (const [token, session] of this.sessions) if (session.username === username) tokens.push(token);
    while (tokens.length >= this.maxPerUser) this.sessions.delete(tokens.shift()!);
  }
}
