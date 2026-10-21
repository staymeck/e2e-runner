import { randomBytes } from "node:crypto";

export const STREAM_TICKETS = Symbol("STREAM_TICKETS");

const TICKET_BYTES = 32;
export const DEFAULT_TICKET_TTL_MS = 30_000;

interface IssuedTicket {
  readonly jobId: string;
  readonly expiresAt: number;
}

/**
 * One-time, short-lived tickets for the log-stream WebSocket, which cannot carry an `Authorization`
 * header: a client gets one from an authenticated `POST .../stream-ticket` and spends it in the
 * handshake's query string instead. In memory only, like the API keys; a restart invalidates every
 * open ticket harmlessly (nothing but a new WS connection needs one).
 */
export class StreamTickets {
  private readonly tickets = new Map<string, IssuedTicket>();

  constructor(private readonly ttlMs: number = DEFAULT_TICKET_TTL_MS) {}

  issue(jobId: string): string {
    this.sweep();
    const ticket = randomBytes(TICKET_BYTES).toString("base64url");
    this.tickets.set(ticket, { jobId, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  /** Spends the ticket: answers at most once, whether it never existed, already expired, or just matched. */
  consume(ticket: string): string | undefined {
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return found && found.expiresAt >= Date.now() ? found.jobId : undefined;
  }

  /** Drops expired, unconsumed tickets so a client that never connects cannot grow this map forever. */
  private sweep(): void {
    const now = Date.now();
    for (const [ticket, { expiresAt }] of this.tickets) {
      if (expiresAt < now) this.tickets.delete(ticket);
    }
  }
}
