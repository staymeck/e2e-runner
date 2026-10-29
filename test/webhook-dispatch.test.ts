import assert from "node:assert/strict";
import * as http from "node:http";
import { describe, it } from "node:test";
import type { Job, JobPhase } from "../src/core/job";
import { postJobWebhookEvent } from "../src/webhooks/dispatch";

/**
 * `postJobWebhookEvent` tested directly, independent of who calls it (`notify-on-finish.test.ts`
 * covers the scheduler-wired path, STA-35). `assertWebhookDestinationSafe` blocks 127.0.0.1 on
 * purpose, so a local test server cannot stand in for a receiver — what *is* real and network-light:
 * a reserved, guaranteed-to-never-resolve `.invalid` hostname (RFC 2606), which exercises the whole
 * failure path — the guard, the diagnostics hook, and the returned result — without a real outbound
 * request ever happening.
 */
function job(overrides: Partial<Job> = {}): Job {
  const phase: JobPhase = { position: 0, name: "scenario", status: "running", exitCode: null, signal: null, outcome: null, startedAt: null, finishedAt: null };
  return {
    seq: 1,
    id: "job-1",
    project: "detox",
    kind: "run",
    status: "running",
    ref: "main",
    sha: "a".repeat(40),
    target: "login",
    params: {},
    locks: ["devices"],
    retryOf: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: null,
    cancelRequestedAt: null,
    outcome: null,
    error: null,
    pid: null,
    logPath: null,
    reportPath: null,
    webhookUrl: null,
    phases: [phase],
    ...overrides,
  };
}

const UNRESOLVABLE_URL = "https://this-host-does-not-exist.invalid/hooks/e2e";

/** The guard checks the allowlist before ever resolving DNS, so the host must be a configured subscriber first. */
async function withSubscriber<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.E2E_WEBHOOK_SUBSCRIBERS;
  process.env.E2E_WEBHOOK_SUBSCRIBERS = "this-host-does-not-exist.invalid:sec";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.E2E_WEBHOOK_SUBSCRIBERS;
    else process.env.E2E_WEBHOOK_SUBSCRIBERS = previous;
  }
}

describe("postJobWebhookEvent", () => {
  it("reports the failure through diagnostics and in the result, for a host that cannot be reached", async () => {
    const warnings: Array<[object, string]> = [];
    const diagnostics = { info: () => undefined, error: () => undefined, warn: (fields: object, message: string) => warnings.push([fields, message]) };

    const result = await withSubscriber(() =>
      postJobWebhookEvent(UNRESOLVABLE_URL, { event: "started", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" }, diagnostics),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && /failed to resolve/i.test(result.error));
    assert.equal(warnings.length, 1);
    const [fields, message] = warnings[0]!;
    assert.match(message, /could not deliver a webhook/);
    assert.equal((fields as { jobId: string }).jobId, "job-1");
    assert.equal((fields as { eventId: string }).eventId, result.eventId);
  });

  it("stays silent by default: diagnostics is optional", async () => {
    const result = await withSubscriber(() => postJobWebhookEvent(UNRESOLVABLE_URL, { event: "started", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" }));
    assert.equal(result.ok, false);
  });

  it("refuses a destination that was never configured as a subscriber, before any diagnostics fire", async () => {
    const warnings: Array<[object, string]> = [];
    const diagnostics = { info: () => undefined, error: () => undefined, warn: (fields: object, message: string) => warnings.push([fields, message]) };
    const result = await postJobWebhookEvent(UNRESOLVABLE_URL, { event: "started", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" }, diagnostics);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /disabled|not in E2E_WEBHOOK_SUBSCRIBERS/i.test(result.error));
    assert.equal(warnings.length, 1, "a failure must still be reported even when it never reached DNS");
  });

  /**
   * SSRF-via-redirect (found by review, STA-35): `assertWebhookDestinationSafe` only validates the
   * host/IP of the URL actually dispatched to — a fetch that auto-follows a 3xx (the default) would
   * send the signed body wherever an *otherwise-allowed* host's `Location` header points, entirely
   * unchecked. Fixed with `redirect: "manual"` in dispatch.ts; the assertion below pins down the exact
   * platform contract that fix depends on, since `postJobWebhookEvent` itself cannot be exercised
   * against a local server here (its own anti-SSRF guard blocks 127.0.0.1 on purpose, by design).
   */
  it("fetch with redirect: manual surfaces the 3xx itself, never follows it — the exact contract the anti-SSRF fix relies on", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.ok, false, "dispatch.ts's existing `!response.ok` check is what turns this into a reported failure");
      assert.equal(response.headers.get("location"), "http://169.254.169.254/latest/meta-data/");
    } finally {
      server.close();
    }
  });
});
