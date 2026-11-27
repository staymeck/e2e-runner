import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_ARTIFACT_TICKET_TTL_MS, type TicketStore } from "./artifact-ticket";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * A `TicketStore` with nothing stored anywhere: a ticket is `base64url(subject:expiresAt).signature`,
 * so `resolve` is pure HMAC verification against `secret` — no map, no database row, nothing that a
 * restart or redeploy can lose. `ArtifactTickets`' in-memory map did lose every outstanding link on
 * restart; that is exactly what broke the general report's long-lived shared link (STA), since any
 * redeploy invalidates it. The only thing that has to survive a restart here is `secret` itself —
 * see `ticket-secret.ts`, which keeps one on disk in `dataDir` for this.
 *
 * Not idempotent the way `ArtifactTickets.issue` is (re-issuing the same subject mints a new,
 * differently-expiring ticket rather than returning an identical string) — harmless here, since
 * nothing is stored to grow unbounded from it, which was the only reason that mattered there.
 */
export class SignedArtifactTickets implements TicketStore {
  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = DEFAULT_ARTIFACT_TICKET_TTL_MS,
  ) {}

  issue(subject: string): string {
    const payload = Buffer.from(`${subject}:${Date.now() + this.ttlMs}`, "utf8").toString("base64url");
    return `${payload}.${sign(payload, this.secret)}`;
  }

  resolve(ticket: string): string | undefined {
    const dot = ticket.lastIndexOf(".");
    if (dot < 0) return undefined;
    const payload = ticket.slice(0, dot);
    const signature = ticket.slice(dot + 1);
    const expected = sign(payload, this.secret);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;

    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf(":");
    if (sep < 0) return undefined;
    const expiresAt = Number(decoded.slice(sep + 1));
    return Number.isFinite(expiresAt) && expiresAt >= Date.now() ? decoded.slice(0, sep) : undefined;
  }
}
