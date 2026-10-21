import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** Ported from the orchestrator's `api/webhook/sign.ts`, unchanged: pure HMAC, no job model involved. */
export function createWebhookEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Stripe-style signature header: `X-Webhook-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`.
 * Signed payload is `${t}.${rawBody}`. One `v1=` per secret, so a receiver mid-rotation can
 * verify with either its current or its previous secret without this side knowing which.
 */
export function buildWebhookSignatureHeader(rawBody: string, secrets: readonly string[], timestampSec: number = Math.floor(Date.now() / 1000)): string {
  const versions = secrets
    .filter((secret) => secret.trim())
    .map((secret) => `v1=${createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex")}`);
  if (versions.length === 0) throw new Error("At least one webhook secret is required to sign");
  return `t=${timestampSec},${versions.join(",")}`;
}

/** For a receiver (or a test standing in for n8n) to check a signature this service produced. */
export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secrets: readonly string[],
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",").map((p) => p.trim())) {
    if (part.startsWith("t=")) timestamp = Number(part.slice(2));
    else if (part.startsWith("v1=")) signatures.push(part.slice(3));
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex"), "utf8");
    for (const actual of signatures) {
      const candidate = Buffer.from(actual, "utf8");
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
    }
  }
  return false;
}
