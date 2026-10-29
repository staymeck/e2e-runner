import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job, JobPhase } from "../src/core/job";
import { buildJobLinks, buildWebhookPayload, toWebhookJobType } from "../src/webhooks/payload";

const SHA = "a".repeat(40);

function phase(overrides: Partial<JobPhase> = {}): JobPhase {
  return { position: 0, name: "scenario", status: "succeeded", exitCode: 0, signal: null, outcome: "success", startedAt: null, finishedAt: null, ...overrides };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    seq: 1,
    id: "job-1",
    project: "detox",
    kind: "run",
    status: "succeeded",
    ref: "main",
    sha: SHA,
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
    phases: [phase()],
    ...overrides,
  };
}

describe("toWebhookJobType", () => {
  it("maps run -> scenario, keeping build and pipeline as they are: n8n already reads it this way", () => {
    assert.equal(toWebhookJobType("run"), "scenario");
    assert.equal(toWebhookJobType("build"), "build");
    assert.equal(toWebhookJobType("pipeline"), "pipeline");
  });
});

describe("buildJobLinks", () => {
  it("builds job and log links from the base URL, without a token (unlike the orchestrator's links)", () => {
    assert.deepEqual(buildJobLinks("https://e2e.example.com", "job-1"), {
      job: "https://e2e.example.com/v1/jobs/job-1",
      log: "https://e2e.example.com/v1/jobs/job-1/log",
    });
  });

  it("tolerates a trailing slash on the base URL", () => {
    assert.deepEqual(buildJobLinks("https://e2e.example.com/", "job-1"), {
      job: "https://e2e.example.com/v1/jobs/job-1",
      log: "https://e2e.example.com/v1/jobs/job-1/log",
    });
  });

  it("adds report with ?ticket= only when a report ticket is given (STA-54)", () => {
    assert.deepEqual(buildJobLinks("https://e2e.example.com", "job-1", "the-ticket"), {
      job: "https://e2e.example.com/v1/jobs/job-1",
      log: "https://e2e.example.com/v1/jobs/job-1/log",
      report: "https://e2e.example.com/v1/jobs/job-1/report?ticket=the-ticket",
    });
    assert.ok(!("report" in buildJobLinks("https://e2e.example.com", "job-1")), "no bare, unusable report link without a ticket");
  });

  it("encodes a ticket that needs it", () => {
    assert.equal(buildJobLinks("https://e2e.example.com", "job-1", "a+b/c").report, "https://e2e.example.com/v1/jobs/job-1/report?ticket=a%2Bb%2Fc");
  });
});

describe("buildWebhookPayload", () => {
  it("carries the job's own id, project, type, outcome and phases straight through", () => {
    const payload = buildWebhookPayload({
      event: "finished",
      job: job(),
      phase: "scenario",
      phaseIndex: 0,
      baseUrl: "https://e2e.example.com",
      eventId: "evt_test",
      timestamp: 1_700_000_000,
    });
    assert.equal(payload.eventId, "evt_test");
    assert.equal(payload.timestamp, 1_700_000_000);
    assert.equal(payload.jobId, "job-1");
    assert.equal(payload.project, "detox");
    assert.equal(payload.type, "scenario");
    assert.equal(payload.jobStatus, "succeeded");
    assert.equal(payload.outcome, "success");
    assert.equal(payload.phaseTotal, 1);
    assert.deepEqual(payload.phases, [{ name: "scenario", status: "succeeded", outcome: "success", exitCode: 0, signal: null }]);
    assert.equal(payload.links.job, "https://e2e.example.com/v1/jobs/job-1");
  });

  it("generates its own eventId and timestamp when none are given", () => {
    const payload = buildWebhookPayload({ event: "started", job: job({ status: "running", outcome: null, finishedAt: null }), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.match(payload.eventId, /^evt_[0-9a-f]+$/);
    assert.ok(Number.isInteger(payload.timestamp) && payload.timestamp > 0);
  });

  it("computes durationMs from startedAt/finishedAt, and leaves it null when either is missing", () => {
    const finished = buildWebhookPayload({ event: "finished", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.equal(finished.durationMs, 30_000);

    const stillRunning = buildWebhookPayload({ event: "started", job: job({ finishedAt: null }), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.equal(stillRunning.durationMs, null);
  });

  it("forwards reportTicket into links.report, and leaves it out when none is given", () => {
    const withTicket = buildWebhookPayload({ event: "finished", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com", reportTicket: "the-ticket" });
    assert.equal(withTicket.links.report, "https://e2e.example.com/v1/jobs/job-1/report?ticket=the-ticket");

    const withoutTicket = buildWebhookPayload({ event: "finished", job: job(), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.ok(!("report" in withoutTicket.links));
  });

  it("never includes a server-side path, only what the Job API itself already exposes (logPath/reportPath excluded)", () => {
    const payload = buildWebhookPayload({ event: "finished", job: job({ logPath: "/var/data/logs/job-1.log", reportPath: "/var/data/reports/job-1" }), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.ok(!JSON.stringify(payload).includes("/var/data"), "a server-side filesystem path leaked into the payload");
  });

  it("never includes the job's own params, even when they hold a recognizable value", () => {
    const payload = buildWebhookPayload({ event: "finished", job: job({ params: { secret: "shouldnotleak" } }), phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.ok(!JSON.stringify(payload).includes("shouldnotleak"), "the job's params leaked into the webhook payload");
    assert.ok(!("params" in payload));
  });

  it("reports the failing phase's own error, for a job that failed mid-run", () => {
    const failing = job({
      status: "failed",
      outcome: null,
      error: 'Phase "scenario" failed (exit code 3)',
      phases: [phase({ status: "failed", outcome: "failure", exitCode: 3 })],
    });
    const payload = buildWebhookPayload({ event: "finished", job: failing, phase: "scenario", phaseIndex: 0, baseUrl: "https://e2e.example.com" });
    assert.equal(payload.jobStatus, "failed");
    assert.equal(payload.error, 'Phase "scenario" failed (exit code 3)');
    assert.deepEqual(payload.phases[0], { name: "scenario", status: "failed", outcome: "failure", exitCode: 3, signal: null });
  });
});
