import { silentDiagnostics, type Diagnostics } from "../core/diagnostics";
import { buildWebhookPayload, type BuildWebhookPayloadOptions, type WebhookPayload } from "./payload";
import { buildWebhookSignatureHeader } from "./sign";
import { getSubscriberSecrets } from "./subscribers";
import { assertWebhookDestinationSafe } from "./url-guard";

/**
 * Adapted from the orchestrator's `api/webhook/dispatch.ts`: same signing and anti-SSRF checks, built
 * on this service's own payload shape. Called from `notify-on-finish.ts` (STA-35), itself wired into
 * `JobScheduler.onFinished` in `main.ts` — only for the "finished" event today, not "started": the
 * only lifecycle point this needed per STA-35's own scope ("los webhooks de fin").
 *
 * The original logged a delivery failure itself (via Nest's own Logger, which this module must not
 * depend on). This takes the service's generic `Diagnostics` instead, defaulting to silent: a caller
 * that cares about visibility passes one in, rather than every failure being swallowed into the
 * returned result and nothing else.
 */
const WEBHOOK_TIMEOUT_MS = 15_000;

export type WebhookDispatchResult = { readonly ok: true; readonly eventId: string } | { readonly ok: false; readonly eventId: string; readonly error: string };

export async function postJobWebhookEvent(url: string, options: BuildWebhookPayloadOptions, diagnostics: Diagnostics = silentDiagnostics): Promise<WebhookDispatchResult> {
  const payload: WebhookPayload = buildWebhookPayload(options);
  const eventId = payload.eventId;
  const fail = (error: string): WebhookDispatchResult => {
    diagnostics.warn({ eventId, jobId: payload.jobId, event: payload.event, error }, "could not deliver a webhook");
    return { ok: false, eventId, error };
  };

  try {
    const parsed = await assertWebhookDestinationSafe(url);
    const secrets = getSubscriberSecrets(parsed.hostname);
    if (!secrets) return fail(`No subscriber secret for host ${parsed.hostname}`);

    const rawBody = JSON.stringify(payload);
    const secretList = secrets.previous ? [secrets.current, secrets.previous] : [secrets.current];
    const signature = buildWebhookSignatureHeader(rawBody, secretList, payload.timestamp);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-id": eventId, "x-webhook-signature": signature },
        body: rawBody,
        signal: controller.signal,
        // `assertWebhookDestinationSafe` only validated *this* URL's host/IP: automatically following a
        // redirect (fetch's default) would send the signed body to wherever a 3xx takes it, unchecked —
        // classic SSRF-via-redirect, reachable from any client with the API key, not just n8n (found by
        // review). Manual mode still returns a normal, readable response for a 3xx (confirmed: `status`
        // and `location` header both present, not an opaque one), so the existing `!response.ok` below
        // already treats it as a plain failure — nothing more to special-case.
        redirect: "manual",
      });
      if (!response.ok) return fail(`Webhook HTTP ${response.status} ${response.statusText}`);
      return { ok: true, eventId };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
