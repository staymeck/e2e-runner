import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getSubscriberSecrets, hasWebhookSubscribers, parseWebhookSubscribers, type WebhookSubscriberSecrets } from "./subscribers";

/**
 * Ported from the orchestrator's `api/webhook/url-guard.ts`. One real change: it threw Nest's
 * `BadRequestException` directly; this module has no business knowing about the HTTP framework, so it
 * throws its own error instead — `request-parsing.ts`'s `parseSubmit` is the caller (STA-35), and
 * `DomainExceptionFilter` maps it to 400, the same way every other domain error in this service already is.
 */
export class WebhookUrlNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlNotAllowedError";
  }
}

/** Sync checks for use at submit time: https, and the host is on the allowlist. */
export function assertWebhookUrlAllowed(urlRaw: string, subscribers: ReadonlyMap<string, WebhookSubscriberSecrets> = parseWebhookSubscribers()): URL {
  if (!hasWebhookSubscribers(subscribers)) throw new WebhookUrlNotAllowedError("Webhooks are disabled (E2E_WEBHOOK_SUBSCRIBERS is not configured)");

  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    throw new WebhookUrlNotAllowedError(`Invalid webhookUrl: ${urlRaw}`);
  }
  if (parsed.protocol !== "https:") throw new WebhookUrlNotAllowedError("webhookUrl must use https");

  const host = parsed.hostname.toLowerCase();
  if (!getSubscriberSecrets(host, subscribers)) throw new WebhookUrlNotAllowedError(`webhookUrl host "${host}" is not in E2E_WEBHOOK_SUBSCRIBERS`);
  if (isIP(host) && isBlockedIpAddress(host)) throw new WebhookUrlNotAllowedError("webhookUrl must not target a private or link-local IP");

  return parsed;
}

/**
 * Resolves DNS and rejects a private/link-local/metadata destination (anti-SSRF, anti-rebinding).
 * Call again right before every outbound POST: `assertWebhookUrlAllowed` alone cannot catch a DNS
 * answer that changes between when a webhook URL was accepted and when it is actually used.
 */
export async function assertWebhookDestinationSafe(urlRaw: string, subscribers: ReadonlyMap<string, WebhookSubscriberSecrets> = parseWebhookSubscribers()): Promise<URL> {
  const parsed = assertWebhookUrlAllowed(urlRaw, subscribers);
  const host = parsed.hostname;

  if (isIP(host)) {
    if (isBlockedIpAddress(host)) throw new WebhookUrlNotAllowedError(`Refusing webhook to blocked IP ${host}`);
    return parsed;
  }

  let address: string;
  try {
    address = (await lookup(host, { all: false })).address;
  } catch (error) {
    throw new WebhookUrlNotAllowedError(`Failed to resolve webhook host ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isBlockedIpAddress(address)) throw new WebhookUrlNotAllowedError(`Refusing webhook to ${host} — resolved to blocked IP ${address}`);

  return parsed;
}

export function isBlockedIpAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v) return true;

  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local address
  if (v.startsWith("fe80:")) return true; // link-local
  if (v === "::" || v === "0:0:0:0:0:0:0:0") return true;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (mapped?.[1]) return isBlockedIpAddress(mapped[1]);

  const parts = v.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return isIP(v) === 0; // not a recognizable address at all: treat as blocked, never as "safe by default"
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

