import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../src/app";
import type { ServiceConfig } from "../src/config/service-config";
import { FakeRefs, OK, fakeAdapter } from "./helpers/fake-adapter";
import { buildService } from "./helpers/service";

const KEY = "current-key-0123456789";
const config: ServiceConfig = { server: { host: "127.0.0.1", port: 0 }, apiKeys: [KEY], dataDir: "/unused", projects: [], detox: undefined };

class ExplodingRefs extends FakeRefs {
  override async pin(): Promise<string> {
    throw new Error("secret internal detail: C:\\perfect\\keys\\id_rsa");
  }
}

describe("jobs API", () => {
  const adapter = fakeAdapter("detox", ["devices"]);
  const ctx = buildService(adapter);
  const errors: string[] = [];
  let app: INestApplication;
  let base: string;

  before(async () => {
    app = await createApp(config, { jobs: ctx.service, diagnostics: { info: () => undefined, warn: () => undefined, error: (_f, m) => errors.push(m) } });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(async () => {
    await app.close();
  });

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const submit = (body: unknown) => call("POST", "/v1/jobs", body);

  describe("authentication", () => {
    it("protects every route", async () => {
      for (const [method, path] of [["GET", "/v1/projects"], ["GET", "/v1/jobs"], ["POST", "/v1/jobs"], ["GET", "/v1/jobs/x"], ["POST", "/v1/jobs/x/cancel"]] as const) {
        const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    });
  });

  describe("GET /v1/projects", () => {
    it("lists what a caller can choose, without the repository URL", async () => {
      const body = (await (await call("GET", "/v1/projects")).json()) as { projects: Array<Record<string, unknown>> };
      assert.deepEqual(body.projects.map((p) => p.id), ["detox", "web"]);
      assert.deepEqual(Object.keys(body.projects[0] as object).sort(), ["allowedBranches", "defaultBranch", "id"]);
    });
  });

  describe("POST /v1/jobs", () => {
    it("queues a job and shows it without server internals", async () => {
      const response = await submit({ project: "detox", ref: "main", target: "login-smoke", params: { retries: 1 } });
      assert.equal(response.status, 201);
      const job = (await response.json()) as Record<string, unknown>;
      assert.deepEqual([job.project, job.ref, job.sha, job.target, job.status, job.kind], ["detox", "main", "a".repeat(40), "login-smoke", "running", "run"]);
      assert.deepEqual(job.params, { retries: 1 });
      assert.equal(job.phase, "scenario");
      for (const internal of ["pid", "logPath", "reportPath", "seq"]) assert.ok(!(internal in job), internal);
      await adapter.executor.finish(job.id as string, OK);
    });

    it("uses the project's default branch and kind when they are left out", async () => {
      const job = (await (await submit({ project: "detox", target: "t" })).json()) as { id: string; ref: string; kind: string };
      assert.deepEqual([job.ref, job.kind], ["iteration_1", "run"]);
      await adapter.executor.finish(job.id, OK);
    });

    it("answers 400 to a request that is malformed, naming the problem", async () => {
      const cases: Array<[unknown, RegExp]> = [
        [{ target: "t" }, /project is required/],
        [{ project: "detox" }, /target is required/],
        [{ project: "detox", target: "t", extra: 1 }, /unknown field "extra"/],
        [{ project: "detox", target: 5 }, /target must be a non-empty string/],
        [{ project: "detox", target: "t", ref: ["main"] }, /ref must be a non-empty string/],
        [{ project: "detox", target: "-rf" }, /not a valid scenario name/],
        [{ project: "detox", target: "t", kind: "pipeline" }, /kind must be one of/],
        [{ project: "detox", target: "t", params: { shell: "x" } }, /unknown or invalid parameter/],
        [["not", "an", "object"], /JSON object/],
        ["null", /Malformed request body/], // the JSON parser itself only accepts objects and arrays
      ];
      for (const [body, message] of cases) {
        const response = await submit(body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(((await response.json()) as { message: string }).message, message);
      }
    });

    it("answers 400 to a body that is not JSON, and to one with no content type", async () => {
      assert.equal((await submit("{not json")).status, 400);
      const noType = await fetch(`${base}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" });
      assert.equal(noType.status, 400);
    });

    it("answers 413 to a body that is too large", async () => {
      const response = await submit({ project: "detox", target: "t", params: { retries: 1, padding: "x".repeat(70_000) } });
      assert.equal(response.status, 413);
    });

    it("answers 403 for a branch the project does not allow, and 404 for an unknown project", async () => {
      assert.equal((await submit({ project: "detox", ref: "feature/x", target: "t" })).status, 403);
      assert.equal((await submit({ project: "detox", ref: "--upload-pack=x", target: "t" })).status, 403);
      assert.equal((await submit({ project: "ghost", target: "t" })).status, 404);
      assert.equal((await submit({ project: "web", target: "t" })).status, 404);
    });

    it("answers 422 for an allowed branch that does not exist", async () => {
      const response = await submit({ project: "detox", ref: "iteration_9", target: "t" });
      assert.equal(response.status, 422);
      assert.equal(((await response.json()) as { error: string }).error, "ref_not_found");
    });

    it("hides the cause of an unexpected error from the client but logs it", async () => {
      const broken = buildService(fakeAdapter("detox", ["devices"], undefined, new ExplodingRefs()));
      const brokenApp = await createApp(config, { jobs: broken.service, diagnostics: { info: () => undefined, warn: () => undefined, error: (_f, m) => errors.push(m) } });
      await brokenApp.listen(0, "127.0.0.1");
      try {
        const port = (brokenApp.getHttpServer().address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ project: "detox", ref: "main", target: "t" }),
        });
        assert.equal(response.status, 500);
        const text = await response.text();
        assert.ok(!text.includes("secret") && !text.includes("id_rsa"), text);
        assert.ok(errors.includes("unhandled error in a request"));
      } finally {
        await brokenApp.close();
      }
    });
  });

  describe("GET /v1/jobs and /v1/jobs/:id", () => {
    const ids: string[] = [];
    before(async () => {
      for (const [ref, target] of [["main", "alpha"], ["main", "beta"], ["iteration_2", "alpha"]] as const) {
        ids.push(((await (await submit({ project: "detox", ref, target })).json()) as { id: string }).id);
      }
    });

    const list = async (query: string) => (await (await call("GET", `/v1/jobs${query}`)).json()) as { jobs: Array<{ id: string; target: string }>; nextCursor: number | null };

    it("lists newest first, and filters by branch, scenario and status", async () => {
      assert.deepEqual((await list("?ref=main&target=alpha")).jobs.map((j) => j.id), [ids[0]]);
      assert.deepEqual((await list("?target=alpha")).jobs.map((j) => j.id), [ids[2], ids[0]]);
      const queued = await list("?status=queued");
      assert.ok(queued.jobs.length >= 2 && queued.jobs.every((j) => ids.includes(j.id)));
      assert.deepEqual((await list("?status=queued&status=running&project=detox&limit=200")).jobs.length > 0, true);
    });

    it("pages with a cursor", async () => {
      const first = await list("?project=detox&limit=2");
      assert.equal(first.jobs.length, 2);
      assert.ok(first.nextCursor);
      const second = await list(`?project=detox&limit=2&before=${first.nextCursor}`);
      assert.ok(second.jobs.every((job) => !first.jobs.some((seen) => seen.id === job.id)));
    });

    it("answers 400 to filters it cannot understand", async () => {
      for (const query of ["?status=bogus", "?status=queued,bogus", "?limit=0", "?limit=abc", "?limit=1&limit=2", "?before=-1", "?before=1.5", "?ref="]) {
        assert.equal((await call("GET", `/v1/jobs${query}`)).status, 400, query);
      }
    });

    it("treats filter values as data", async () => {
      assert.deepEqual((await list("?ref=" + encodeURIComponent("x' OR '1'='1"))).jobs, []);
    });

    it("shows one job with its phases, and 404 for an unknown one", async () => {
      const job = (await (await call("GET", `/v1/jobs/${ids[0]}`)).json()) as { id: string; phases: unknown[] };
      assert.equal(job.id, ids[0]);
      assert.equal(job.phases.length, 1);
      assert.equal((await call("GET", "/v1/jobs/ghost")).status, 404);
    });

    it("cancels a queued job (200, cancelled) and a running one (200, cancelling), then 409 once finished", async () => {
      const queued = (await (await call("POST", `/v1/jobs/${ids[1]}/cancel`)).json()) as { status: string };
      assert.equal(queued.status, "cancelled");

      const running = ctx.service.list({ statuses: ["running"] }).jobs[0];
      assert.ok(running);
      const cancelling = await call("POST", `/v1/jobs/${running.id}/cancel`);
      assert.equal(cancelling.status, 200);
      assert.equal(((await cancelling.json()) as { status: string }).status, "cancelling");
      assert.equal((await call("POST", `/v1/jobs/${running.id}/cancel`)).status, 200, "idempotent while cancelling");

      await adapter.executor.finish(running.id, { exitCode: 1, outcome: "failure" });
      const done = await call("POST", `/v1/jobs/${running.id}/cancel`);
      assert.equal(done.status, 409);
      assert.equal(((await done.json()) as { error: string }).error, "job_finished");
      assert.equal((await call("POST", "/v1/jobs/ghost/cancel")).status, 404);
    });

    it("frees the resources: the next queued job starts when the running one is cancelled", async () => {
      const next = ctx.service.list({ statuses: ["running"] }).jobs[0];
      assert.ok(next, "the cancelled job's successor is running now");
      await adapter.executor.finish(next.id, OK);
    });
  });
});
