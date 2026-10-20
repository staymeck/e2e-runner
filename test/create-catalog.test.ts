import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createDetoxCatalog } from "../src/adapters/detox/create-catalog";
import type { DependencyInstaller } from "../src/adapters/detox/dependency-installer";
import type { ProjectConfig } from "../src/config/service-config";
import { ConfigError } from "../src/core/problems";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { CatalogFixture, git } from "./helpers/git-fixture";
import { scratchDir } from "./helpers/workspace";

const installer: DependencyInstaller = { ensure: async () => false };

function project(repo: string): ProjectConfig {
  return { id: "detox", adapter: "detox", repo, allowedBranches: ["main", "iteration_*"], defaultBranch: "iteration_1" };
}

describe("createDetoxCatalog", () => {
  it("builds a working catalog over two worktrees of the project's repository", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const catalog = await createDetoxCatalog({ runnerDir: fixture.runnerDir, infoDir: fixture.infoDir }, project(fixture.remote), new ExecCommandRunner(), installer);
    assert.deepEqual(await catalog.refs(), ["iteration_1", "iteration_2", "main"]);
  });

  it("refuses to start on a wrong deployment, listing everything wrong", async () => {
    const root = scratchDir();
    const fixture = new CatalogFixture(root);
    const clone = path.join(root, "separate-clone");
    git(root, "clone", "-q", fixture.remote, clone);
    await assert.rejects(
      createDetoxCatalog({ runnerDir: fixture.runnerDir, infoDir: clone }, project("git@git.example.com:other/repo.git"), new ExecCommandRunner(), installer),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.problems.length >= 3, error.message);
        return true;
      },
    );
  });
});
