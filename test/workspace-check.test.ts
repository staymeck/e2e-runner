import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../src/adapters/detox/git-repo";
import { checkWorkspaces, normalizeRepoUrl } from "../src/adapters/detox/workspace-check";
import { Problems } from "../src/core/problems";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { CatalogFixture, git } from "./helpers/git-fixture";
import { makeDir, scratchDir } from "./helpers/workspace";

const runner = new ExecCommandRunner();

async function problemsFor(runnerDir: string, infoDir: string, repo: string): Promise<readonly string[]> {
  const problems = new Problems();
  await checkWorkspaces(new GitRepo(runnerDir, runner), new GitRepo(infoDir, runner), repo, problems);
  return problems.list;
}

describe("checkWorkspaces", () => {
  it("accepts two worktrees of the configured repository", async () => {
    const fixture = new CatalogFixture(scratchDir());
    assert.deepEqual(await problemsFor(fixture.runnerDir, fixture.infoDir, fixture.remote), []);
  });

  it("accepts the same repository written another way", async () => {
    const fixture = new CatalogFixture(scratchDir());
    assert.deepEqual(await problemsFor(fixture.runnerDir, fixture.infoDir, `${fixture.remote}/`.replace(/\.git\/$/, "")), []);
  });

  it("tells apart two separate clones, which would not share fetches or pinned commits", async () => {
    const root = scratchDir();
    const fixture = new CatalogFixture(root);
    const second = path.join(root, "second-clone");
    git(root, "clone", "-q", fixture.remote, second);
    const problems = await problemsFor(fixture.runnerDir, second, fixture.remote);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /separate clones.*git worktree add/);
  });

  it("reports a folder that is not a git working tree, and one that is not a catalog", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const plain = makeDir(fixture.root, "plain");
    const problems = await problemsFor(fixture.runnerDir, plain, fixture.remote);
    assert.ok(problems.some((p) => p.includes("E2E_DETOX_INFO_DIR is not a git working tree")));

    fs.rmSync(path.join(fixture.infoDir, "orch.rc.json"));
    const catalogProblems = await problemsFor(fixture.runnerDir, fixture.infoDir, fixture.remote);
    assert.ok(catalogProblems.some((p) => p.includes("E2E_DETOX_INFO_DIR has no orch.rc.json")));
  });

  it("reports an origin that is a different repository from the project's", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const problems = await problemsFor(fixture.runnerDir, fixture.infoDir, "git@git.example.com:other/repo.git");
    assert.equal(problems.filter((p) => p.includes("different repository")).length, 2);
  });

  it("reports every problem, not only the first", async () => {
    const root = scratchDir();
    const problems = await problemsFor(makeDir(root, "a"), makeDir(root, "b"), "git@x.com:y/z.git");
    assert.equal(problems.length, 2);
  });
});

describe("checkWorkspaces: the folders themselves", () => {
  it("refuses a folder that is a sub-folder of a working tree, not its root", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const sub = makeDir(fixture.runnerDir, "e2e-testing");
    fs.writeFileSync(path.join(sub, "orch.rc.json"), "{}");
    const problems = await problemsFor(sub, fixture.infoDir, fixture.remote);
    assert.ok(problems.some((p) => p.includes("sub-folder of a working tree")));
  });

  it("refuses a folder with uncommitted work: the service would wipe it before the first job", async () => {
    const fixture = new CatalogFixture(scratchDir());
    fs.writeFileSync(path.join(fixture.runnerDir, "my-notes.txt"), "do not lose");
    const problems = await problemsFor(fixture.runnerDir, fixture.infoDir, fixture.remote);
    assert.ok(problems.some((p) => p.includes("E2E_DETOX_RUNNER_DIR has uncommitted changes")));
    fs.writeFileSync(path.join(fixture.infoDir, "orch.rc.json"), "{\"changed\":true}");
    assert.ok((await problemsFor(fixture.runnerDir, fixture.infoDir, fixture.remote)).some((p) => p.includes("E2E_DETOX_INFO_DIR has uncommitted changes")));
  });

  it("refuses the same working tree given twice, even through a different spelling", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const again = `${fixture.runnerDir}${path.sep}.`;
    const problems = await problemsFor(fixture.runnerDir, again, fixture.remote);
    assert.ok(problems.some((p) => p.includes("the same working tree")));
  });
});

describe("normalizeRepoUrl", () => {
  it("ignores .git, trailing slashes, credentials, ports and case", () => {
    const same = [
      "git@Host.com:Org/Repo.git",
      "git@host.com:org/repo",
      "git@host.com:org/repo/",
      " git@host.com:org/repo.git ",
      "ssh://git@host.com/org/repo.git",
      "ssh://git@host.com:2222/org/repo",
      "https://host.com/org/repo",
      "https://token:secret@host.com/org/repo.git/",
      "HTTPS://HOST.COM/Org/Repo",
    ];
    assert.equal(new Set(same.map(normalizeRepoUrl)).size, 1, same.map(normalizeRepoUrl).join(" | "));
  });

  it("tells different repositories and hosts apart", () => {
    const base = normalizeRepoUrl("git@host.com:org/repo");
    for (const other of ["git@host.com:org/other", "git@other.com:org/repo", "git@host.com:other/repo", "https://host.com/org/repo-two"]) {
      assert.notEqual(normalizeRepoUrl(other), base, other);
    }
  });

  it("compares local paths as paths, however the slashes are written", () => {
    assert.equal(normalizeRepoUrl("C:\\repos\\Catalog.git"), normalizeRepoUrl("c:/repos/catalog"));
    assert.equal(normalizeRepoUrl("file:///srv/git/catalog.git"), normalizeRepoUrl("/srv/git/catalog/"));
    assert.notEqual(normalizeRepoUrl("C:\\repos\\a"), normalizeRepoUrl("C:\\repos\\b"));
  });
});
