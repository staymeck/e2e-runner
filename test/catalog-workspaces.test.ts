import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CatalogError, CommitUnavailableError, GitCatalogWorkspaces } from "../src/adapters/detox/catalog-workspaces";
import type { DependencyInstaller } from "../src/adapters/detox/dependency-installer";
import { GitRepo } from "../src/adapters/detox/git-repo";
import { RefNotAllowedError, RefNotFoundError } from "../src/core/job-request";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { CatalogFixture, git } from "./helpers/git-fixture";
import { scratchDir } from "./helpers/workspace";

class RecordingInstaller implements DependencyInstaller {
  readonly installed: string[] = [];
  async ensure(dir: string): Promise<boolean> {
    this.installed.push(dir);
    return true;
  }
}

const ALLOWED = ["main", "iteration_*"];

function setup(allowed: readonly string[] = ALLOWED) {
  const fixture = new CatalogFixture(scratchDir());
  const runner = new ExecCommandRunner();
  const installer = new RecordingInstaller();
  const catalog = new GitCatalogWorkspaces(new GitRepo(fixture.runnerDir, runner), new GitRepo(fixture.infoDir, runner), allowed, installer);
  return { fixture, installer, catalog };
}

describe("refs", () => {
  it("lists the allowed remote branches only, sorted", async () => {
    const { catalog } = setup();
    assert.deepEqual(await catalog.refs(), ["iteration_1", "iteration_2", "main"]);
  });

  it("shows branches that appear after a fetch, and drops the ones deleted upstream", async () => {
    const { catalog, fixture } = setup();
    fixture.branch("iteration_3", "main");
    assert.ok(!(await catalog.refs()).includes("iteration_3"), "nothing is known before the fetch");
    await catalog.fetch();
    assert.ok((await catalog.refs()).includes("iteration_3"));
    fixture.deleteBranch("iteration_3");
    await catalog.fetch();
    assert.ok(!(await catalog.refs()).includes("iteration_3"));
  });
});

describe("pin", () => {
  it("resolves an allowed branch to its commit", async () => {
    const { catalog, fixture } = setup();
    assert.equal(await catalog.pin("iteration_2"), fixture.sha("iteration_2"));
  });

  it("refuses branches the project does not allow, and names that are not branches", async () => {
    const { catalog } = setup();
    for (const ref of ["feature/not-allowed", "--upload-pack=x", "iteration_/../x", "iteration_1\n", ""]) {
      await assert.rejects(catalog.pin(ref), RefNotAllowedError, JSON.stringify(ref));
    }
  });

  it("reports a branch that is allowed but does not exist", async () => {
    const { catalog } = setup();
    await assert.rejects(catalog.pin("iteration_99"), RefNotFoundError);
  });

  it("never resolves a tag or a commit id, even if the patterns would allow any name", async () => {
    const { catalog, fixture } = setup(["*"]);
    fixture.tag("v1");
    await catalog.fetch();
    await assert.rejects(catalog.pin("v1"), RefNotFoundError);
    await assert.rejects(catalog.pin(fixture.sha("main")), RefNotFoundError);
    await assert.rejects(catalog.pin("HEAD"), RefNotAllowedError, "origin/HEAD is a pointer, not a branch");
  });

  it("keeps the commit alive after the branch moves and the repository is cleaned up", async () => {
    const { catalog, fixture } = setup();
    const doomed = fixture.commit("iteration_2", "doomed.txt", "x");
    await catalog.fetch();
    const pinned = await catalog.pin("iteration_2");
    assert.equal(pinned, doomed);

    const unpinned = fixture.commit("iteration_1", "other.txt", "y");
    await catalog.fetch();
    fixture.forcePush("iteration_2", "main"); // the commit is no longer on any branch
    fixture.forcePush("iteration_1", "main");
    await catalog.fetch();
    fixture.collectGarbage();

    assert.ok(fixture.has(pinned), "the pinned commit survived garbage collection");
    assert.ok(!fixture.has(unpinned), "an unpinned one did not (so the test proves something)");
  });

  it("can release a pin, and prune the ones nobody needs", async () => {
    const { catalog, fixture } = setup();
    fixture.commit("iteration_1", "one.txt", "1");
    fixture.commit("iteration_2", "two.txt", "2");
    await catalog.fetch();
    const a = await catalog.pin("main");
    const b = await catalog.pin("iteration_1");
    await catalog.pin("iteration_2");
    assert.equal(new Set([a, b, fixture.sha("iteration_2")]).size, 3, "three different commits");

    await catalog.release(a);
    await catalog.release(a); // idempotent
    assert.equal(await catalog.prunePins(new Set([b])), 1, "only the third was left to remove");
    assert.equal(await catalog.prunePins(new Set()), 1, "now b");
    assert.equal(await catalog.prunePins(new Set()), 0);
  });
});

describe("browse", () => {
  it("puts the browsing folder, detached, on the branch's commit", async () => {
    const { catalog, fixture } = setup();
    const tip = fixture.commit("iteration_2", "scenario.txt", "hello");
    await catalog.fetch();
    const workspace = await catalog.browse("iteration_2");
    assert.deepEqual([workspace.dir, workspace.sha], [fixture.infoDir, tip]);
    assert.equal(fixture.headOf(fixture.infoDir), tip);
    assert.equal(git(fixture.infoDir, "branch", "--show-current"), "", "detached: no branch is checked out");
    assert.equal(fs.readFileSync(path.join(fixture.infoDir, "scenario.txt"), "utf8"), "hello");
  });

  it("never moves the run folder, so a job in progress is not affected", async () => {
    const { catalog, fixture } = setup();
    const running = fixture.sha("iteration_1");
    await catalog.prepareRun(running);
    await catalog.browse("iteration_2");
    await catalog.browse("main");
    assert.equal(fixture.headOf(fixture.runnerDir), running);
  });

  it("refuses a commit that is not a catalog", async () => {
    const { catalog, fixture } = setup(["*"]);
    fixture.uncatalogedBranch("plain");
    await catalog.fetch();
    await assert.rejects(catalog.browse("plain"), CatalogError);
  });

  it("refuses branches that are not allowed", async () => {
    const { catalog } = setup();
    await assert.rejects(catalog.browse("feature/not-allowed"), RefNotAllowedError);
  });
});

describe("prepareRun", () => {
  it("runs exactly the pinned commit even if the branch moved and a fetch happened afterwards", async () => {
    const { catalog, fixture } = setup();
    const pinned = await catalog.pin("iteration_1");
    fixture.commit("iteration_1", "later.txt", "newer");
    await catalog.fetch();
    assert.notEqual(fixture.sha("iteration_1"), pinned);

    const workspace = await catalog.prepareRun(pinned);
    assert.deepEqual([workspace.dir, workspace.sha], [fixture.runnerDir, pinned]);
    assert.equal(fixture.headOf(fixture.runnerDir), pinned);
    assert.ok(!fs.existsSync(path.join(fixture.runnerDir, "later.txt")));
  });

  it("installs dependencies in the run folder, after the checkout", async () => {
    const { catalog, fixture, installer } = setup();
    await catalog.prepareRun(fixture.sha("main"));
    assert.deepEqual(installer.installed, [fixture.runnerDir]);
  });

  it("starts every job from a clean tree: edits and untracked files go, ignored files stay", async () => {
    const { catalog, fixture } = setup();
    const sha = fixture.sha("iteration_1");
    await catalog.prepareRun(sha);
    fs.writeFileSync(path.join(fixture.runnerDir, "orch.rc.json"), "tampered");
    fs.writeFileSync(path.join(fixture.runnerDir, "leftover.txt"), "from the last job");
    fs.mkdirSync(path.join(fixture.runnerDir, "builds"), { recursive: true });
    fs.writeFileSync(path.join(fixture.runnerDir, "builds", "app.apk"), "cache");
    fs.writeFileSync(path.join(fixture.runnerDir, ".env"), "KEEP=1");

    await catalog.prepareRun(sha);
    assert.ok(fs.readFileSync(path.join(fixture.runnerDir, "orch.rc.json"), "utf8").includes("e2eDir"));
    assert.ok(!fs.existsSync(path.join(fixture.runnerDir, "leftover.txt")));
    assert.ok(fs.existsSync(path.join(fixture.runnerDir, "builds", "app.apk")), "the build cache is kept");
    assert.ok(fs.existsSync(path.join(fixture.runnerDir, ".env")), "local configuration is kept");
  });

  it("refuses a commit the repository does not have, leaving the folder where it was", async () => {
    const { catalog, fixture } = setup();
    const before = fixture.headOf(fixture.runnerDir);
    await assert.rejects(catalog.prepareRun("f".repeat(40)), CommitUnavailableError);
    for (const bad of ["main", "--detach", "", "abc", "A".repeat(40)]) await assert.rejects(catalog.prepareRun(bad), CommitUnavailableError, bad);
    assert.equal(fixture.headOf(fixture.runnerDir), before);
  });

  it("does not install when the commit is refused", async () => {
    const { catalog, installer } = setup();
    await assert.rejects(catalog.prepareRun("e".repeat(40)), CommitUnavailableError);
    assert.deepEqual(installer.installed, []);
  });

  it("refuses a commit that is not a catalog", async () => {
    const { catalog, fixture } = setup(["*"]);
    const sha = fixture.uncatalogedBranch("plain");
    await catalog.fetch();
    await assert.rejects(catalog.prepareRun(sha), CatalogError);
  });
});

describe("concurrency", () => {
  it("serialises git operations: a burst of fetches, browses, pins and runs all succeed", async () => {
    const ctx = setup();
    const sha = ctx.fixture.sha("iteration_1");
    const results = await Promise.all([
      ctx.catalog.fetch(),
      ctx.catalog.browse("iteration_2"),
      ctx.catalog.pin("main"),
      ctx.catalog.prepareRun(sha),
      ctx.catalog.refs(),
      ctx.catalog.fetch(),
      ctx.catalog.browse("main"),
    ]);
    assert.equal(results.length, 7);
    assert.equal(ctx.fixture.headOf(ctx.fixture.runnerDir), sha);
  });
});
