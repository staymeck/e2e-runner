import { randomBytes } from "node:crypto";

export const ARTIFACT_TICKETS = Symbol("ARTIFACT_TICKETS");

const TICKET_BYTES = 32;
export const DEFAULT_ARTIFACT_TICKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface IssuedTicket {
  readonly jobId: string;
  readonly expiresAt: number;
}

/**
 * Long-lived, reusable tickets scoped to one job's artifact routes (today: `GET .../report`) — for a
 * link a webhook/email/Slack message hands to someone with no session of their own, so, unlike
 * `StreamTickets`' one-shot WS ticket, it must keep working across multiple opens over its whole
 * lifetime: someone opening an email days later, or reopening the same link twice, is the normal case
 * here, not an edge case. `issue` is idempotent per job — re-issuing for the same job returns the
 * still-valid existing ticket instead of leaking a fresh one on every call (a finished job's `report`
 * link, and a "copy link" button for the same job, both just call `issue` again).
 *
 * In memory only, like `StreamTickets`/`WebSessions`: a restart drops every outstanding link
 * harmlessly (the next finished job gets a fresh one; nothing but opening the link needs this
 * process specifically). The periodic sweep is opt-in (`sweepIntervalMs`), the same as
 * `JobScheduler`'s `recheckIntervalMs`: a 30-day TTL means the lazy, issue-triggered sweep alone
 * could leave a month of expired entries sitting in memory between finished jobs, so production
 * wiring (`main.ts`) turns the periodic sweep on explicitly; nothing about the class itself requires it.
 */
export class ArtifactTickets {
  private readonly tickets = new Map<string, IssuedTicket>();
  private readonly byJob = new Map<string, string>();
  private readonly sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ttlMs: number = DEFAULT_ARTIFACT_TICKET_TTL_MS,
    sweepIntervalMs?: number,
  ) {
    if (sweepIntervalMs) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  issue(jobId: string): string {
    this.sweep();
    const existing = this.byJob.get(jobId);
    if (existing) return existing;
    const ticket = randomBytes(TICKET_BYTES).toString("base64url");
    this.tickets.set(ticket, { jobId, expiresAt: Date.now() + this.ttlMs });
    this.byJob.set(jobId, ticket);
    return ticket;
  }

  /** The job it was issued for, or undefined if it never existed or has expired. Never consumed. */
  resolve(ticket: string): string | undefined {
    const found = this.tickets.get(ticket);
    return found && found.expiresAt >= Date.now() ? found.jobId : undefined;
  }

  /** Drops expired tickets so a flow that mints many short-lived jobs cannot grow this map forever. */
  private sweep(): void {
    const now = Date.now();
    for (const [ticket, { jobId, expiresAt }] of this.tickets) {
      if (expiresAt < now) {
        this.tickets.delete(ticket);
        if (this.byJob.get(jobId) === ticket) this.byJob.delete(jobId);
      }
    }
  }
}
