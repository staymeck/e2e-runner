import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CatalogUnsupportedError, UnknownProjectError } from "../src/core/adapter";
import { JobAlreadyFinishedError, JobNotFoundError } from "../src/core/job";
import { InvalidJobRequestError, RefNotAllowedError, RefNotFoundError } from "../src/core/job-request";
import { FakeExecutor, FakeProjectCatalog, FakeRefs, OK, SHA_MAIN, fakeAdapter } from "./helpers/fake-adapter";
import { buildService } from "./helpers/service";

const nothingCreated = (ctx: ReturnType<typeof buildService>) => assert.equal(ctx.store.list().jobs.length, 0);

describe("JobService.submit", () => {
  it("queues a job on the default branch and kind, pinned to the commit seen now", async () => {
    const ctx = buildService();
    const job = await ctx.service.submit({ project: "detox", target: "login-smoke" });
    assert.deepEqual([job.ref, job.kind, job.sha, job.target], ["iteration_1", "run", "b".repeat(40), "login-smoke"]);
    assert.deepEqual(job.locks, ["devices"]);
    assert.equal(job.status, "running", "nothing was in the way");
    await ctx.adapter.executor.finish(job.id, OK);
  });

  it("takes an explicit branch, kind and parameters", async () => {
    const ctx = buildService();
    const job = await ctx.service.submit({ project: "detox", ref: "main", kind: "build", target: "t", params: { retries: 2 } });
    assert.deepEqual([job.ref, job.sha, job.kind, job.params], ["main", SHA_MAIN, "build", { retries: 2 }]);
    await ctx.adapter.executor.finish(job.id, OK);
  });

  it("keeps the commit it pinned even if the branch moves afterwards", async () => {
    const refs = new FakeRefs({ main: "1".repeat(40) });
    const ctx = buildService(fakeAdapter("detox", ["devices"], undefined, refs));
    const job = await ctx.service.submit({ project: "detox", ref: "main", target: "t" });
    refs.commits.main = "2".repeat(40);
    assert.equal(ctx.service.get(job.id).sha, "1".repeat(40));
    await ctx.adapter.executor.finish(job.id, OK);
  });

  it("refuses a branch the project does not allow, before touching the repository", async () => {
    const ctx = buildService();
    await assert.rejects(ctx.service.submit({ project: "detox", ref: "feature/x", target: "t" }), RefNotAllowedError);
    assert.deepEqual(ctx.adapter.refs.pinned, []);
    nothingCreated(ctx);
  });

  it("refuses branch names that are not safe even where a pattern would match", async () => {
    const ctx = buildService();
    for (const ref of ["--upload-pack=x", "iteration_/../x", "iteration_ 1", "iteration_1\n", "main;ls", "$(id)"]) {
      await assert.rejects(ctx.service.submit({ project: "detox", ref, target: "t" }), RefNotAllowedError, JSON.stringify(ref));
    }
    assert.deepEqual(ctx.adapter.refs.pinned, []);
  });

  it("reports an allowed branch that does not exist, creating nothing", async () => {
    const ctx = buildService();
    await assert.rejects(ctx.service.submit({ project: "detox", ref: "iteration_9", target: "t" }), RefNotFoundError);
    nothingCreated(ctx);
  });

  it("refuses a kind the adapter does not know", async () => {
    const ctx = buildService();
    await assert.rejects(ctx.service.submit({ project: "detox", kind: "pipeline", target: "t" }), InvalidJobRequestError);
    nothingCreated(ctx);
  });

  it("refuses target names that are not scenario names", async () => {
    const ctx = buildService();
    for (const target of ["", "-rf", "a b", "x;y", "a\nb", "$(id)", "a".repeat(201), "../x", "a/../b", "a/.."]) {
      await assert.rejects(ctx.service.submit({ project: "detox", target }), InvalidJobRequestError, JSON.stringify(target));
    }
    nothingCreated(ctx);
  });

  it("lets the adapter reject the parameters, before pinning or creating anything", async () => {
    const ctx = buildService();
    await assert.rejects(ctx.service.submit({ project: "detox", target: "t", params: { shell: "rm -rf /" } }), InvalidJobRequestError);
    await assert.rejects(ctx.service.submit({ project: "detox", target: "t", params: "text" }), InvalidJobRequestError);
    assert.deepEqual(ctx.adapter.refs.pinned, []);
    nothingCreated(ctx);
  });

  it("rejects an unknown project, and a configured one whose adapter is not registered", async () => {
    const ctx = buildService();
    await assert.rejects(ctx.service.submit({ project: "ghost", target: "t" }), UnknownProjectError);
    await assert.rejects(ctx.service.submit({ project: "web", target: "t" }), UnknownProjectError);
    nothingCreated(ctx);
  });

  it("does not queue anything when the adapter returns something that is not a commit", async () => {
    const ctx = buildService(fakeAdapter("detox", ["devices"], undefined, new FakeRefs({ main: "not-a-commit" })));
    await assert.rejects(ctx.service.submit({ project: "detox", ref: "main", target: "t" }), /invalid commit/);
    nothingCreated(ctx);
  });

  it("releases the commit it pinned when the job could not be created", async () => {
    const executor = new FakeExecutor();
    executor.plan = () => {
      throw new Error("cannot plan");
    };
    const refs = new FakeRefs({ main: SHA_MAIN });
    const ctx = buildService(fakeAdapter("detox", ["devices"], executor, refs));
    await assert.rejects(ctx.service.submit({ project: "detox", ref: "main", target: "t" }), /cannot plan/);
    assert.deepEqual(refs.released, [SHA_MAIN]);
    nothingCreated(ctx);
  });

  it("does not release anything when the job was created", async () => {
    const refs = new FakeRefs({ main: SHA_MAIN });
    const ctx = buildService(fakeAdapter("detox", ["devices"], undefined, refs));
    const job = await ctx.service.submit({ project: "detox", ref: "main", target: "t" });
    assert.deepEqual(refs.released, []);
    await ctx.adapter.executor.finish(job.id, OK);
  });

  it("is not stopped by a release that fails", async () => {
    const refs = new FakeRefs({ main: "not-a-commit" });
    refs.release = async () => {
      throw new Error("release broke");
    };
    const ctx = buildService(fakeAdapter("detox", ["devices"], undefined, refs));
    await assert.rejects(ctx.service.submit({ project: "detox", ref: "main", target: "t" }), /invalid commit/);
  });
});

describe("JobService reads and cancel", () => {
  it("gets a job, lists with filters and reports unknown ids", async () => {
    const ctx = buildService();
    const a = await ctx.service.submit({ project: "detox", ref: "main", target: "one" });
    const b = await ctx.service.submit({ project: "detox", ref: "iteration_2", target: "two" });
    assert.equal(ctx.service.get(a.id).target, "one");
    assert.throws(() => ctx.service.get("ghost"), JobNotFoundError);
    assert.deepEqual(ctx.service.list({ ref: "iteration_2" }).jobs.map((job) => job.id), [b.id]);
    await ctx.adapter.executor.finish(a.id, OK);
    await ctx.adapter.executor.finish(b.id, OK);
  });

  it("cancels a queued job and a running one, and refuses a finished one", async () => {
    const ctx = buildService();
    const running = await ctx.service.submit({ project: "detox", ref: "main", target: "one" });
    const queued = await ctx.service.submit({ project: "detox", ref: "main", target: "two" });
    assert.equal((await ctx.service.cancel(queued.id)).status, "cancelled");
    assert.equal((await ctx.service.cancel(running.id)).status, "cancelling");
    await ctx.adapter.executor.finish(running.id, { exitCode: 1, outcome: "failure" });
    assert.equal(ctx.service.get(running.id).status, "cancelled");
    await assert.rejects(ctx.service.cancel(running.id), JobAlreadyFinishedError);
    await assert.rejects(ctx.service.cancel("ghost"), JobNotFoundError);
  });

  it("lists the configured projects", () => {
    assert.deepEqual(buildService().service.projects().map((p) => p.id), ["detox", "web"]);
  });
});

describe("JobService.catalogOf", () => {
  it("rejects an unknown project, and a configured one whose adapter is not registered", () => {
    const ctx = buildService();
    assert.throws(() => ctx.service.catalogOf("ghost"), UnknownProjectError);
    assert.throws(() => ctx.service.catalogOf("web"), UnknownProjectError);
  });

  it("reports a registered adapter that has no browsable catalog", () => {
    const ctx = buildService(fakeAdapter("detox", ["devices"])); // no `browsable` attached
    assert.throws(() => ctx.service.catalogOf("detox"), CatalogUnsupportedError);
  });

  it("returns the adapter's own catalog when it has one", async () => {
    const catalog = new FakeProjectCatalog(["main"], { main: [{ id: "login", title: null }] });
    const ctx = buildService({ ...fakeAdapter("detox", ["devices"]), browsable: catalog });
    const found = ctx.service.catalogOf("detox");
    assert.deepEqual(await found.refs(), ["main"]);
    assert.deepEqual(await found.browse("main"), { sha: "main-sha00000000000000000000000000000000" });
    assert.deepEqual(await found.targets(), [{ id: "login", title: null }]);
  });
});
