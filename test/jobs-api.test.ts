import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createApp } from "../src/app";
import type { ServiceConfig } from "../src/config/service-config";
import { FakeRefs, OK, fakeAdapter, type FakeAdapter } from "./helpers/fake-adapter";
import { buildService } from "./helpers/service";

const KEY = "current-key-0123456789";
const config: ServiceConfig = { server: { host: "127.0.0.1", port: 0 }, apiKeys: [KEY], dataDir: "/unused", projects: [], detox: undefined };

interface Api {
  readonly ctx: ReturnType<typeof buildService>;
  readonly adapter: FakeAdapter;
  readonly logged: string[];
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  submit(body: unknown): Promise<Response>;
  json<T>(response: Promise<Response>): Promise<T>;
}

/** A fresh service, adapter and HTTP server for each test: no test depends on what another left behind. */
async function withApi(run: (api: Api) => Promise<void>, adapter: FakeAdapter = fakeAdapter("detox", ["devices"])): Promise<void> {
  const ctx = buildService(adapter);
  const logged: string[] = [];
  const app = await createApp(config, {
    jobs: ctx.service,
    diagnostics: { info: () => undefined, warn: () => undefined, error: (_fields, message) => logged.push(message) },
  });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const call: Api["call"] = (method, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  try {
    await run({ ctx, adapter, logged, call, submit: (body) => call("POST", "/v1/jobs", body), json: async (response) => (await response).json() as never });
  } finally {
    await app.close();
  }
}

interface JobBody {
  id: string;
  status: string;
  ref: string;
  sha: string;
  kind: string;
  target: string;
  phase: string | null;
  params: unknown;
  phases: unknown[];
  error?: string;
}

const noJobsOrPins = (api: Api) => {
  assert.equal(api.ctx.store.list().jobs.length, 0, "no job was created");
  assert.deepEqual(api.adapter.refs.pinned, [], "the repository was not touched");
};

describe("authentication", () => {
  it("protects every route, answering 401 before 404 and without revealing anything", async () => {
    await withApi(async (api) => {
      for (const [method, path] of [["GET", "/v1/projects"], ["GET", "/v1/jobs"], ["POST", "/v1/jobs"], ["GET", "/v1/jobs/ghost"], ["POST", "/v1/jobs/ghost/cancel"]] as const) {
        const response = await api.call(method, path, method === "POST" ? {} : undefined, { authorization: "" });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.equal(response.headers.get("www-authenticate"), "Bearer");
      }
    });
  });

  it("rejects a wrong key and a different scheme", async () => {
    await withApi(async (api) => {
      assert.equal((await api.call("GET", "/v1/jobs", undefined, { authorization: "Bearer wrong-key-0123456789" })).status, 401);
      assert.equal((await api.call("GET", "/v1/jobs", undefined, { authorization: `Basic ${KEY}` })).status, 401);
    });
  });

  it("does not advertise the framework, and grants no cross-origin access", async () => {
    await withApi(async (api) => {
      const response = await api.call("GET", "/v1/projects");
      assert.equal(response.headers.get("x-powered-by"), null);
      const preflight = await api.call("OPTIONS", "/v1/jobs", undefined, { origin: "https://evil.example", "access-control-request-method": "POST" });
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    });
  });
});

describe("GET /v1/projects", () => {
  it("lists what a caller can choose, without the repository URL", async () => {
    await withApi(async (api) => {
      const body = await api.json<{ projects: Array<Record<string, unknown>> }>(api.call("GET", "/v1/projects"));
      assert.deepEqual(body.projects.map((p) => p.id), ["detox", "web"]);
      assert.deepEqual(Object.keys(body.projects[0] as object).sort(), ["allowedBranches", "defaultBranch", "id"]);
    });
  });
});

describe("POST /v1/jobs", () => {
  it("queues a job and shows it without server internals", async () => {
    await withApi(async (api) => {
      const response = await api.submit({ project: "detox", ref: "main", target: "login-smoke", params: { retries: 1 } });
      assert.equal(response.status, 201);
      const job = (await response.json()) as JobBody;
      assert.deepEqual([job.ref, job.sha, job.target, job.status, job.kind, job.phase], ["main", "a".repeat(40), "login-smoke", "running", "run", "scenario"]);
      assert.deepEqual(job.params, { retries: 1 });
      for (const internal of ["pid", "logPath", "reportPath", "seq"]) assert.ok(!(internal in job), internal);
    });
  });

  it("uses the project's default branch and kind when they are left out", async () => {
    await withApi(async (api) => {
      const job = await api.json<JobBody>(api.submit({ project: "detox", target: "t" }));
      assert.deepEqual([job.ref, job.kind], ["iteration_1", "run"]);
    });
  });

  it("answers 400 to a malformed request, naming the problem and creating nothing", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ target: "t" }, /project is required/],
      [{ project: "detox" }, /target is required/],
      [{ project: "detox", target: "t", extra: 1 }, /unknown field "extra"/],
      [{ project: "detox", target: 5 }, /target must be a non-empty string/],
      [{ project: "detox", target: "t", ref: ["main"] }, /ref must be a non-empty string/],
      [{ project: "detox", target: "-rf" }, /not a valid scenario name/],
      [{ project: "detox", target: "a/../b" }, /not a valid scenario name/],
      [{ project: "detox", target: "t", kind: "pipeline" }, /kind must be one of/],
      [{ project: "detox", target: "t", params: { shell: "x" } }, /unknown or invalid parameter/],
      [["not", "an", "object"], /JSON object/],
      ["null", /^Bad Request$/], // the JSON parser itself only accepts objects and arrays; its text is not echoed
    ];
    await withApi(async (api) => {
      for (const [body, message] of cases) {
        const response = await api.submit(body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(((await response.json()) as { message: string }).message, message);
      }
      noJobsOrPins(api);
    });
  });

  it("answers 400 to a body that is not JSON, and to one with no content type", async () => {
    await withApi(async (api) => {
      assert.equal((await api.submit("{not json")).status, 400);
      const noType = await fetch(`${await baseOf(api)}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" });
      assert.equal(noType.status, 400); // the body is ignored without a content type, so the required fields are missing
    });
  });

  it("answers 413 to a body that is too large", async () => {
    await withApi(async (api) => {
      const response = await api.submit({ project: "detox", target: "t", params: { retries: 1, padding: "x".repeat(70_000) } });
      assert.equal(response.status, 413);
      assert.equal(((await response.json()) as { error: string }).error, "payload_too_large");
    });
  });

  it("does not let __proto__ in the parameters reach the adapter or pollute anything", async () => {
    await withApi(async (api) => {
      const response = await api.submit('{"project":"detox","target":"t","params":{"__proto__":{"polluted":true}}}');
      assert.equal(response.status, 400);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal((await api.submit('{"__proto__":{"x":1},"project":"detox","target":"t"}')).status, 400);
      noJobsOrPins(api);
    });
  });

  it("answers 403 for a branch the project does not allow, without touching the repository", async () => {
    await withApi(async (api) => {
      assert.equal((await api.submit({ project: "detox", ref: "feature/x", target: "t" })).status, 403);
      assert.equal((await api.submit({ project: "detox", ref: "--upload-pack=x", target: "t" })).status, 403);
      noJobsOrPins(api);
    });
  });

  it("answers 404 for an unknown project and for one without an adapter", async () => {
    await withApi(async (api) => {
      assert.equal((await api.submit({ project: "ghost", target: "t" })).status, 404);
      assert.equal((await api.submit({ project: "web", target: "t" })).status, 404);
      noJobsOrPins(api);
    });
  });

  it("answers 422 for an allowed branch that does not exist", async () => {
    await withApi(async (api) => {
      const response = await api.submit({ project: "detox", ref: "iteration_9", target: "t" });
      assert.equal(response.status, 422);
      assert.equal(((await response.json()) as { error: string }).error, "ref_not_found");
      assert.equal(api.ctx.store.list().jobs.length, 0);
    });
  });

  it("hides the cause of an unexpected error from the client but logs it", async () => {
    class ExplodingRefs extends FakeRefs {
      override async pin(): Promise<string> {
        throw new Error("secret internal detail: C:\\perfect\\keys\\id_rsa");
      }
    }
    await withApi(
      async (api) => {
        const response = await api.submit({ project: "detox", ref: "main", target: "t" });
        assert.equal(response.status, 500);
        const text = await response.text();
        assert.ok(!text.includes("secret") && !text.includes("id_rsa"), text);
        assert.ok(api.logged.includes("unhandled error in a request"));
      },
      fakeAdapter("detox", ["devices"], undefined, new ExplodingRefs()),
    );
  });

  it("does not take any error that merely carries a status for the client's fault", async () => {
    class StatusError extends FakeRefs {
      override async pin(): Promise<string> {
        throw Object.assign(new Error("upstream said no"), { status: 404 });
      }
    }
    await withApi(
      async (api) => {
        const response = await api.submit({ project: "detox", ref: "main", target: "t" });
        assert.equal(response.status, 500);
        assert.ok(!(await response.text()).includes("upstream"));
      },
      fakeAdapter("detox", ["devices"], undefined, new StatusError()),
    );
  });
});

describe("GET /v1/jobs", () => {
  /** Four jobs on the same resource: the first runs, the other three wait. Returns their ids, oldest first. */
  async function fourJobs(api: Api): Promise<string[]> {
    const ids: string[] = [];
    for (const [ref, target] of [["main", "alpha"], ["main", "beta"], ["iteration_2", "alpha"], ["iteration_2", "gamma"]] as const) {
      ids.push((await api.json<JobBody>(api.submit({ project: "detox", ref, target }))).id);
    }
    return ids;
  }
  const list = (api: Api, query: string) => api.json<{ jobs: Array<{ id: string; status: string }>; nextCursor: number | null }>(api.call("GET", `/v1/jobs${query}`));

  it("lists newest first and filters by branch, scenario and status", async () => {
    await withApi(async (api) => {
      const [a, b, c, d] = await fourJobs(api);
      assert.deepEqual((await list(api, "")).jobs.map((j) => j.id), [d, c, b, a]);
      assert.deepEqual((await list(api, "?ref=main")).jobs.map((j) => j.id), [b, a]);
      assert.deepEqual((await list(api, "?target=alpha")).jobs.map((j) => j.id), [c, a]);
      assert.deepEqual((await list(api, "?project=detox&ref=iteration_2&target=alpha")).jobs.map((j) => j.id), [c]);
      assert.deepEqual((await list(api, "?status=running")).jobs.map((j) => j.id), [a]);
      assert.deepEqual((await list(api, "?status=queued")).jobs.map((j) => j.id), [d, c, b]);
      assert.deepEqual((await list(api, "?status=running,queued")).jobs.length, 4);
      assert.deepEqual((await list(api, "?status=running&status=queued")).jobs.length, 4);
      assert.deepEqual((await list(api, "?status=succeeded")).jobs, []);
    });
  });

  it("pages through everything with the cursor: every job once, newest first, ending with no cursor", async () => {
    await withApi(async (api) => {
      const ids = await fourJobs(api);
      const seen: string[] = [];
      let query = "?limit=3";
      for (let guard = 0; guard < 5; guard++) {
        const page = await list(api, query);
        assert.ok(page.jobs.length > 0, "a page is never empty while a cursor exists");
        seen.push(...page.jobs.map((j) => j.id));
        if (page.nextCursor === null) break;
        query = `?limit=3&before=${page.nextCursor}`;
      }
      assert.deepEqual(seen, [...ids].reverse());
      assert.equal((await list(api, "?limit=4")).nextCursor, null);
    });
  });

  it("answers 400 to filters it cannot understand, including keys it does not know", async () => {
    await withApi(async (api) => {
      const bad = ["?status=bogus", "?status=queued,bogus", "?limit=0", "?limit=abc", "?limit=201", "?limit=1&limit=2", "?before=-1", "?before=1.5", "?ref=", "?ref=a&ref=b", "?stauts=queued", "?ref[a]=b", "?__proto__[x]=1"];
      for (const query of bad) assert.equal((await api.call("GET", `/v1/jobs${query}`)).status, 400, query);
    });
  });

  it("treats filter values as data", async () => {
    await withApi(async (api) => {
      await fourJobs(api);
      assert.deepEqual((await list(api, `?ref=${encodeURIComponent("x' OR '1'='1")}`)).jobs, []);
      assert.equal((await list(api, "")).jobs.length, 4);
    });
  });
});

describe("GET /v1/jobs/:id", () => {
  it("shows one job with its phases, and answers 404 for an unknown one", async () => {
    await withApi(async (api) => {
      const created = await api.json<JobBody>(api.submit({ project: "detox", ref: "main", target: "t" }));
      const job = await api.json<JobBody>(api.call("GET", `/v1/jobs/${created.id}`));
      assert.deepEqual([job.id, job.phases.length], [created.id, 1]);
      assert.equal((await api.call("GET", "/v1/jobs/ghost")).status, 404);
    });
  });
});

describe("POST /v1/jobs/:id/cancel", () => {
  it("cancels a queued job: 200, cancelled, and it never runs", async () => {
    await withApi(async (api) => {
      await api.submit({ project: "detox", ref: "main", target: "first" });
      const queued = await api.json<JobBody>(api.submit({ project: "detox", ref: "main", target: "second" }));
      const cancelled = await api.json<JobBody>(api.call("POST", `/v1/jobs/${queued.id}/cancel`));
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(api.adapter.executor.started.filter((s) => s.startsWith(queued.id)), []);
    });
  });

  it("cancels a running job (200, cancelling, idempotent), then answers 409 once it ended", async () => {
    await withApi(async (api) => {
      const running = await api.json<JobBody>(api.submit({ project: "detox", ref: "main", target: "t" }));
      const first = await api.call("POST", `/v1/jobs/${running.id}/cancel`);
      assert.equal(first.status, 200);
      assert.equal(((await first.json()) as JobBody).status, "cancelling");
      assert.equal((await api.call("POST", `/v1/jobs/${running.id}/cancel`)).status, 200, "idempotent while cancelling");

      await api.adapter.executor.finish(running.id, { exitCode: 1, outcome: "failure" });
      const done = await api.call("POST", `/v1/jobs/${running.id}/cancel`);
      assert.equal(done.status, 409);
      assert.equal(((await done.json()) as { error: string }).error, "job_finished");
    });
  });

  it("answers 404 for an unknown job", async () => {
    await withApi(async (api) => {
      assert.equal((await api.call("POST", "/v1/jobs/ghost/cancel")).status, 404);
    });
  });

  it("frees the resources: the next queued job starts when the running one is cancelled", async () => {
    await withApi(async (api) => {
      const running = await api.json<JobBody>(api.submit({ project: "detox", ref: "main", target: "first" }));
      const next = await api.json<JobBody>(api.submit({ project: "detox", ref: "main", target: "second" }));
      assert.equal(next.status, "queued");
      await api.call("POST", `/v1/jobs/${running.id}/cancel`);
      await api.adapter.executor.finish(running.id, { exitCode: 1, outcome: "failure" });
      assert.equal((await api.json<JobBody>(api.call("GET", `/v1/jobs/${next.id}`))).status, "running");
      await api.adapter.executor.finish(next.id, OK);
    });
  });
});

/** The base URL is only needed for the one request that cannot go through `call`. */
async function baseOf(api: Api): Promise<string> {
  const response = await api.call("GET", "/v1/health");
  return new URL(response.url).origin;
}
