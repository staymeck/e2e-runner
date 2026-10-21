import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWebhookSignatureHeader, verifyWebhookSignature } from "../src/webhooks/sign";

describe("webhook HMAC sign", () => {
  it("signs and verifies with the current secret", () => {
    const body = JSON.stringify({ event: "finished", jobId: "job_1" });
    const t = 1_700_000_000;
    const header = buildWebhookSignatureHeader(body, ["sec_live"], t);
    assert.match(header, /^t=1700000000,v1=[0-9a-f]+$/);
    assert.equal(verifyWebhookSignature(body, header, ["sec_live"], 300, t), true);
  });

  it("accepts either secret during rotation", () => {
    const body = "{}";
    const t = 1_700_000_000;
    const header = buildWebhookSignatureHeader(body, ["sec_new", "sec_old"], t);
    assert.equal(verifyWebhookSignature(body, header, ["sec_old"], 300, t), true);
    assert.equal(verifyWebhookSignature(body, header, ["sec_new"], 300, t), true);
  });

  it("rejects a tampered body", () => {
    const t = 1_700_000_000;
    const header = buildWebhookSignatureHeader("{}", ["sec"], t);
    assert.equal(verifyWebhookSignature('{"x":1}', header, ["sec"], 300, t), false);
  });

  it("rejects an expired timestamp", () => {
    const t = 1_700_000_000;
    const header = buildWebhookSignatureHeader("{}", ["sec"], t);
    assert.equal(verifyWebhookSignature("{}", header, ["sec"], 300, t + 301), false);
  });

  it("rejects a header with no timestamp or no signature", () => {
    assert.equal(verifyWebhookSignature("{}", "v1=abc", ["sec"]), false);
    assert.equal(verifyWebhookSignature("{}", "t=1700000000", ["sec"]), false);
  });

  it("refuses to sign with no secrets at all", () => {
    assert.throws(() => buildWebhookSignatureHeader("{}", []), /at least one webhook secret/i);
  });
});
