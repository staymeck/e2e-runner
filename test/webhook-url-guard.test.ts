import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWebhookSubscribers } from "../src/webhooks/subscribers";
import { assertWebhookDestinationSafe, assertWebhookUrlAllowed, isBlockedIpAddress, WebhookUrlNotAllowedError } from "../src/webhooks/url-guard";

describe("parseWebhookSubscribers", () => {
  it("parses host:secret and a rotation pair", () => {
    const map = parseWebhookSubscribers("hooks.example.com:sec_a:sec_b,ci.example.org:only");
    assert.deepEqual(map.get("hooks.example.com"), { current: "sec_a", previous: "sec_b" });
    assert.deepEqual(map.get("ci.example.org"), { current: "only" });
  });

  it("is empty for an unset or blank value", () => {
    assert.equal(parseWebhookSubscribers(undefined).size, 0);
    assert.equal(parseWebhookSubscribers("   ").size, 0);
  });

  it("rejects an entry with no secret or no host", () => {
    assert.throws(() => parseWebhookSubscribers("no-colon-here"), /expected host:secret/i);
    assert.throws(() => parseWebhookSubscribers(":secret-no-host"), /expected host:secret/i);
  });
});

describe("isBlockedIpAddress", () => {
  it("blocks private and link-local ranges", () => {
    assert.equal(isBlockedIpAddress("127.0.0.1"), true);
    assert.equal(isBlockedIpAddress("10.0.0.5"), true);
    assert.equal(isBlockedIpAddress("192.168.1.1"), true);
    assert.equal(isBlockedIpAddress("172.16.0.1"), true);
    assert.equal(isBlockedIpAddress("169.254.169.254"), true, "the cloud metadata address");
    assert.equal(isBlockedIpAddress("100.64.0.1"), true, "CGNAT");
    assert.equal(isBlockedIpAddress("::1"), true);
    assert.equal(isBlockedIpAddress("fe80::1"), true);
    assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true, "an IPv4-mapped IPv6 address");
  });

  it("allows public IPv4", () => {
    assert.equal(isBlockedIpAddress("8.8.8.8"), false);
    assert.equal(isBlockedIpAddress("1.1.1.1"), false);
  });

  it("treats anything it cannot parse as blocked, never as safe by default", () => {
    assert.equal(isBlockedIpAddress("not-an-ip"), true);
    assert.equal(isBlockedIpAddress(""), true);
  });
});

describe("assertWebhookUrlAllowed", () => {
  it("rejects every URL when no subscribers are configured", () => {
    assert.throws(() => assertWebhookUrlAllowed("https://hooks.example.com/x", new Map()), /disabled/i);
  });

  it("rejects http, and a host that is not on the allowlist", () => {
    const subscribers = parseWebhookSubscribers("hooks.example.com:sec");
    assert.throws(() => assertWebhookUrlAllowed("http://hooks.example.com/x", subscribers), /https/i);
    assert.throws(() => assertWebhookUrlAllowed("https://evil.example/x", subscribers), /not in E2E_WEBHOOK_SUBSCRIBERS/i);
  });

  it("accepts an allowlisted https host", () => {
    const subscribers = parseWebhookSubscribers("hooks.example.com:sec");
    const ok = assertWebhookUrlAllowed("https://hooks.example.com/hooks/e2e", subscribers);
    assert.equal(ok.hostname, "hooks.example.com");
  });

  it("rejects an allowlisted host given as a blocked literal IP", () => {
    const subscribers = parseWebhookSubscribers("127.0.0.1:sec");
    assert.throws(() => assertWebhookUrlAllowed("https://127.0.0.1/x", subscribers), WebhookUrlNotAllowedError);
  });

  it("rejects a malformed URL with its own message, not a crash", () => {
    const subscribers = parseWebhookSubscribers("hooks.example.com:sec");
    assert.throws(() => assertWebhookUrlAllowed("not a url", subscribers), /invalid webhookurl/i);
  });
});

describe("assertWebhookDestinationSafe", () => {
  // Real DNS, not mocked: "localhost" resolves via the machine's own hosts file, no network needed,
  // and is exactly the anti-rebinding case this function exists for — an allowlisted *hostname* that
  // resolves to a blocked IP. assertWebhookUrlAllowed alone cannot catch this: it only looks at the
  // hostname in the URL, never what it resolves to.
  it("rejects an allowlisted hostname that resolves to a blocked IP", async () => {
    const subscribers = parseWebhookSubscribers("localhost:sec");
    await assert.rejects(assertWebhookDestinationSafe("https://localhost/x", subscribers), WebhookUrlNotAllowedError);
  });

  it("still enforces the allowlist and https checks before ever resolving DNS", async () => {
    const subscribers = parseWebhookSubscribers("hooks.example.com:sec");
    await assert.rejects(assertWebhookDestinationSafe("https://not-a-subscriber.example/x", subscribers), /not in E2E_WEBHOOK_SUBSCRIBERS/i);
    await assert.rejects(assertWebhookDestinationSafe("http://hooks.example.com/x", subscribers), /https/i);
  });

  it("reports a host that cannot be resolved at all, instead of throwing an unrelated error", async () => {
    const subscribers = parseWebhookSubscribers("this-host-does-not-exist.invalid:sec");
    await assert.rejects(assertWebhookDestinationSafe("https://this-host-does-not-exist.invalid/x", subscribers), /failed to resolve/i);
  });
});
