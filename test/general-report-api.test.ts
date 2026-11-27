import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createApp } from "../src/app";
import { ArtifactTickets, GENERAL_REPORT_TICKET_SUBJECT } from "../src/auth/artifact-ticket";
import type { ServiceConfig } from "../src/config/service-config";
import type { Job } from "../src/core/job";
import { SqliteGeneralReportStore } from "../src/db/sqlite-general-report-store";
import { OK, fakeAdapter } from "./helpers/fake-adapter";
import { buildService } from "./helpers/service";

const KEY = "current-key-0123456789";
const config: ServiceConfig = {
  server: { host: "127.0.0.1", port: 0 },
  apiKeys: [KEY],
  webUsers: [],
  dataDir: "/unused",
  reportBranch: "iteration_1",
  projects: [],
  detox: undefined,
};

interface Api {
  readonly tickets: ArtifactTickets;
  call(method: string, path: string, headers?: Record<string, string>): Promise<Response>;
  finishedJob(target: string, outcome: Job["outcome"]): Promise<Job>;
  record(job: Job): void;
}

async function withApi(run: (api: Api) => Promise<void>): Promise<void> {
  const ctx = buildService(fakeAdapter("detox", ["devices"]));
  const generalReportStore = new SqliteGeneralReportStore(ctx.db);
  const tickets = new ArtifactTickets();
  const app = await createApp(config, {
    jobs: ctx.service,
    artifactTickets: tickets,
    generalReportStore,
    reportBranch: "iteration_1",
    publicBaseUrl: "https://e2e.example.com/orchestrator",
  });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const call: Api["call"] = (method, path, headers = {}) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, ...headers } });
  // Mirrors what main.ts's onFinished composition does — this test harness builds its own JobService
  // (buildService) without a scheduler onFinished hook, so it is driven by hand here instead.
  const finishedJob = async (target: string, outcome: Job["outcome"]): Promise<Job> => {
    const job = await ctx.service.submit({ project: "detox", ref: "iteration_1", target });
    await ctx.adapter.executor.finish(job.id, outcome === "success" ? OK : { ...OK, outcome: "failure", exitCode: 1 });
    const row = ctx.store.get(job.id);
    assert.ok(row, `job ${job.id} not found after finishing`);
    return row;
  };
  try {
    // Mirrors main.ts's onFinished: a "run" job's report always names exactly one scenario (its own target).
    const record: Api["record"] = (job) => generalReportStore.recordFinished(job, job.outcome ? [{ target: job.target, outcome: job.outcome }] : []);
    await run({ tickets, call, finishedJob, record });
  } finally {
    await app.close();
  }
}

describe("GET /v1/report/general", () => {
  it("reflects only the latest finished run per scenario on the tracked branch", async () => {
    await withApi(async (api) => {
      const firstFail = await api.finishedJob("login-smoke", "failure");
      api.record(firstFail);
      const response1 = await api.call("GET", "/v1/report/general");
      assert.equal(response1.status, 200);
      const body1 = (await response1.json()) as { project: string; branch: string; scenarios: Array<{ target: string; latestOutcome: string; latestJobId: string }> };
      assert.equal(body1.branch, "iteration_1");
      assert.deepEqual(body1.scenarios, [{ target: "login-smoke", latestOutcome: "failure", latestJobId: firstFail.id, latestFinishedAt: firstFail.finishedAt }]);

      const thenPass = await api.finishedJob("login-smoke", "success");
      api.record(thenPass);
      const response2 = await api.call("GET", "/v1/report/general");
      const body2 = (await response2.json()) as { scenarios: Array<{ target: string; latestOutcome: string; latestJobId: string }> };
      assert.equal(body2.scenarios.length, 1, "still one row, now updated, not two");
      assert.deepEqual(body2.scenarios[0], { target: "login-smoke", latestOutcome: "success", latestJobId: thenPass.id, latestFinishedAt: thenPass.finishedAt });
    });
  });

  it("answers 401 with no credential at all — this endpoint is not public", async () => {
    await withApi(async (api) => {
      const response = await api.call("GET", "/v1/report/general", { authorization: "" });
      assert.equal(response.status, 401);
    });
  });
});

describe("GET /v1/report/general/link", () => {
  it("hands back an absolute, openable URL carrying a fresh general-report ticket", async () => {
    await withApi(async (api) => {
      const response = await api.call("GET", "/v1/report/general/link");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { url: string };
      assert.match(body.url, /^https:\/\/e2e\.example\.com\/orchestrator\/v1\/report\/general\/html\?ticket=/);

      const ticket = new URL(body.url).searchParams.get("ticket");
      assert.ok(ticket);
      assert.equal(api.tickets.resolve(ticket!), GENERAL_REPORT_TICKET_SUBJECT);
    });
  });

  it("answers 401 with no credential at all — this endpoint is not public", async () => {
    await withApi(async (api) => {
      const response = await api.call("GET", "/v1/report/general/link", { authorization: "" });
      assert.equal(response.status, 401);
    });
  });
});

describe("GET /v1/report/general/html", () => {
  it("opens with a valid general-report ticket and no Authorization at all", async () => {
    await withApi(async (api) => {
      const failing = await api.finishedJob("login-smoke", "failure");
      api.record(failing);
      const ticket = api.tickets.issue(GENERAL_REPORT_TICKET_SUBJECT);

      const response = await api.call("GET", `/v1/report/general/html?ticket=${ticket}`, { authorization: "" });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const html = await response.text();
      assert.match(html, /login-smoke/);
      assert.match(html, new RegExp(`jobs/${failing.id}/report\\?ticket=`));
    });
  });

  it("answers 401 for a ticket issued for a job, not the general-report subject", async () => {
    await withApi(async (api) => {
      const ticket = api.tickets.issue("some-job-id");
      const response = await api.call("GET", `/v1/report/general/html?ticket=${ticket}`, { authorization: "" });
      assert.equal(response.status, 401);
    });
  });

  it("answers 401 with no ticket and no Authorization", async () => {
    await withApi(async (api) => {
      const response = await api.call("GET", "/v1/report/general/html", { authorization: "" });
      assert.equal(response.status, 401);
    });
  });
});
