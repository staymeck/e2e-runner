import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job, JobPhase } from "../src/core/job";
import { notifyOnFinish, type TicketIssuer } from "../src/webhooks/notify-on-finish";

/** Same `.invalid` DNS trick as webhook-dispatch.test.ts: exercises the whole dispatch path for real, with no outbound request ever reaching a network. */
const UNRESOLVABLE_URL = "https://this-host-does-not-exist.invalid/hooks/e2e";

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

function job(overrides: Partial<Job> = {}): Job {
  const phase: JobPhase = { position: 0, name: "scenario", status: "succeeded", exitCode: 0, signal: null, outcome: "success", startedAt: null, finishedAt: null };
  return {
    seq: 1,
    id: "job-1",
    project: "detox",
    kind: "run",
    status: "succeeded",
    ref: "main",
    sha: "a".repeat(40),
    target: "login",
    params: {},
    locks: ["devices"],
    retryOf: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:31.000Z",
    cancelRequestedAt: null,
    outcome: "success",
    error: null,
    pid: null,
    logPath: null,
    reportPath: null,
    webhookUrl: null,
    phases: [phase],
    ...overrides,
  };
}

class FakeTickets implements TicketIssuer {
  readonly issuedFor: string[] = [];
  issue(jobId: string): string {
    this.issuedFor.push(jobId);
    return `ticket-for-${jobId}`;
  }
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("notifyOnFinish", () => {
  it("issues a report ticket whenever the job has a report, regardless of webhookUrl", async () => {
    const tickets = new FakeTickets();
    const hook = notifyOnFinish(tickets, "https://e2e.example.com", silent);
    await hook(job({ reportPath: "/reports/scenario-run-x", webhookUrl: null }));
    assert.deepEqual(tickets.issuedFor, ["job-1"]);
  });

  it("issues nothing for a job with no report", async () => {
    const tickets = new FakeTickets();
    const hook = notifyOnFinish(tickets, "https://e2e.example.com", silent);
    await hook(job({ reportPath: null, webhookUrl: null }));
    assert.deepEqual(tickets.issuedFor, []);
  });

  it("never attempts a dispatch when webhookUrl is null — nothing warned, even with a report", async () => {
    const warnings: string[] = [];
    const diagnostics = { info: () => undefined, error: () => undefined, warn: (_f: object, m: string) => warnings.push(m) };
    const hook = notifyOnFinish(new FakeTickets(), "https://e2e.example.com", diagnostics);
    await hook(job({ reportPath: "/reports/x", webhookUrl: null }));
    assert.deepEqual(warnings, []);
  });

  it("dispatches a finished event for a job with a webhookUrl, reporting failure through diagnostics the same way postJobWebhookEvent itself does", async () => {
    await withSubscriber(async () => {
      const tickets = new FakeTickets();
      const warnings: Array<[object, string]> = [];
      const diagnostics = { info: () => undefined, error: () => undefined, warn: (fields: object, message: string) => warnings.push([fields, message]) };
      const hook = notifyOnFinish(tickets, "https://e2e.example.com", diagnostics);

      await hook(job({ reportPath: "/reports/x", webhookUrl: UNRESOLVABLE_URL }));

      assert.deepEqual(tickets.issuedFor, ["job-1"], "the ticket is issued before the dispatch is attempted");
      assert.equal(warnings.length, 1);
      const [fields, message] = warnings[0]!;
      assert.match(message, /could not deliver a webhook/);
      assert.equal((fields as { jobId: string }).jobId, "job-1");
    });
  });

  it("dispatches just the same for a failed or a cancelled job — STA-35 asked for 'finished', not 'succeeded'", async () => {
    await withSubscriber(async () => {
      for (const status of ["failed", "cancelled"] as const) {
        const warnings: Array<[object, string]> = [];
        const diagnostics = { info: () => undefined, error: () => undefined, warn: (fields: object, message: string) => warnings.push([fields, message]) };
        const hook = notifyOnFinish(new FakeTickets(), "https://e2e.example.com", diagnostics);
        await hook(job({ status, outcome: status === "failed" ? null : "warning", error: status === "failed" ? "it broke" : null, webhookUrl: UNRESOLVABLE_URL }));
        assert.equal(warnings.length, 1, status);
      }
    });
  });

  it("awaits the dispatch (returns a promise, not void) so a caller can tell when it is actually done", async () => {
    await withSubscriber(async () => {
      const outcome = await notifyOnFinish(new FakeTickets(), "https://e2e.example.com", silent)(job({ webhookUrl: UNRESOLVABLE_URL }));
      assert.equal(outcome, undefined); // resolves cleanly even though the dispatch itself failed — errors never throw out of here
    });
  });

  it("never rejects even when the ticket issuer itself throws — a caller that never awaits this must never see an unhandled rejection (found by review)", async () => {
    class ThrowingTickets implements TicketIssuer {
      issue(): string {
        throw new Error("boom from the ticket issuer");
      }
    }
    const errors: Array<[object, string]> = [];
    const diagnostics = { info: () => undefined, warn: () => undefined, error: (fields: object, message: string) => errors.push([fields, message]) };
    const hook = notifyOnFinish(new ThrowingTickets(), "https://e2e.example.com", diagnostics);

    await assert.doesNotReject(hook(job({ reportPath: "/reports/x" })));

    assert.equal(errors.length, 1);
    const [fields, message] = errors[0]!;
    assert.match(message, /onFinished notification failed unexpectedly/);
    assert.equal((fields as { job: string }).job, "job-1");
  });
});
