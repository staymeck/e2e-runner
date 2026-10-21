/**
 * Ported from the orchestrator's `api/webhook/subscribers.ts`. Renamed env var to this service's own
 * convention (`E2E_WEBHOOK_SUBSCRIBERS`, not `ORCH_WEBHOOK_SUBSCRIBERS`); the parsing itself is unchanged.
 */
export interface WebhookSubscriberSecrets {
  readonly current: string;
  readonly previous?: string;
}

/**
 * Parses `E2E_WEBHOOK_SUBSCRIBERS=host:current[:previous],other.host:secret`. Hostnames must not
 * contain `:`; secrets must not contain `,` or `:`.
 */
export function parseWebhookSubscribers(raw: string | undefined = process.env.E2E_WEBHOOK_SUBSCRIBERS): ReadonlyMap<string, WebhookSubscriberSecrets> {
  const map = new Map<string, WebhookSubscriberSecrets>();
  const trimmed = raw?.trim();
  if (!trimmed) return map;

  for (const entry of trimmed.split(",")) {
    const part = entry.trim();
    if (!part) continue;
    const firstColon = part.indexOf(":");
    if (firstColon <= 0) throw new Error(`Invalid E2E_WEBHOOK_SUBSCRIBERS entry "${part}" (expected host:secret)`);
    const host = part.slice(0, firstColon).trim().toLowerCase();
    const rest = part.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    const current = (secondColon < 0 ? rest : rest.slice(0, secondColon)).trim();
    const previous = secondColon < 0 ? undefined : rest.slice(secondColon + 1).trim() || undefined;
    if (!host || !current) throw new Error(`Invalid E2E_WEBHOOK_SUBSCRIBERS entry "${part}" (empty host or secret)`);
    map.set(host, previous ? { current, previous } : { current });
  }
  return map;
}

export function getSubscriberSecrets(hostname: string, subscribers: ReadonlyMap<string, WebhookSubscriberSecrets> = parseWebhookSubscribers()): WebhookSubscriberSecrets | undefined {
  return subscribers.get(hostname.trim().toLowerCase());
}

export function hasWebhookSubscribers(subscribers: ReadonlyMap<string, WebhookSubscriberSecrets> = parseWebhookSubscribers()): boolean {
  return subscribers.size > 0;
}
