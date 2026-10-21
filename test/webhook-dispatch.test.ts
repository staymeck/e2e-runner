import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job, JobPhase } from "../src/core/job";
import { postJobWebhookEvent } from "../src/webhooks/dispatch";

/**
 * No real outbound POST here (nothing is wired to call this from the scheduler yet — see
 * docs/design.md), and `assertWebhookDestinationSafe` blocks 127.0.0.1 on purpose, so a local test
 * server cannot stand in for a receiver. What *is* real and network-light: a reserved, guaranteed-to-
 * never-resolve `.invalid` hostname (RFC 2606), which exercises the whole failure path — the guard,
 * the diagnostics hook, and the returned result — without a real outbound request ever happening.
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
});
