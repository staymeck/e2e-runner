import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitRepo } from "../src/adapters/detox/git-repo";
import { CommandFailedError, type CommandOptions, type CommandResult, type CommandRunner } from "../src/core/command-runner";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { CatalogFixture, git } from "./helpers/git-fixture";
import { scratchDir } from "./helpers/workspace";

type Handler = (args: readonly string[]) => CommandResult | Error;

/** A runner that answers from a script and remembers how git was called. */
class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ args: readonly string[]; options: CommandOptions }> = [];
  constructor(private readonly handler: Handler) {}
  async run(_command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    const answer = this.handler(args);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "" });
const failed = (exitCode: number | null, message = "x") => new CommandFailedError("git", ["x"], exitCode, message);
const A_SHA = "a".repeat(40);

describe("GitRepo: 'no' is not the same as 'broke'", () => {
  const SSH = { GIT_SSH_COMMAND: "ssh" }; // the deployment chose ssh: the questions below reach git itself

  it("treats the exit code git uses for 'absent' as an answer", async () => {
    const repo = new GitRepo("/x", new ScriptedRunner((args) => (args[0] === "remote" ? failed(2) : failed(1))), SSH);
    assert.equal(await repo.remoteCommit("nope"), undefined);
    assert.equal(await repo.isPinned(A_SHA), false);
    assert.equal(await repo.remoteUrl(), undefined);
  });

  it("rethrows anything else: a timeout, a corrupt repository, a missing git", async () => {
    for (const problem of [failed(null, "timed out after 30000 ms"), failed(128, "fatal: not a git repository"), failed(2)]) {
      const repo = new GitRepo("/x", new ScriptedRunner((args) => (args[0] === "remote" ? failed(128) : problem)), SSH);
      await assert.rejects(repo.remoteCommit("main"), CommandFailedError);
      await assert.rejects(repo.isPinned(A_SHA), CommandFailedError);
      await assert.rejects(repo.remoteUrl(), CommandFailedError);
    }
  });

  it("does not take a broken ssh probe for an answer to the question being asked", async () => {
    const saved = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      // `git config` fails with exit 2, the code `remote get-url` uses for "no such remote"
      const repo = new GitRepo("/x", new ScriptedRunner((args) => (args[0] === "config" ? failed(2) : ok("git@host:org/repo\n"))));
      await assert.rejects(repo.remoteUrl(), CommandFailedError);
    } finally {
      if (saved !== undefined) process.env.GIT_SSH_COMMAND = saved;
    }
  });
});

describe("GitRepo: how git is called", () => {
  it("never lets a stray GIT_DIR or GIT_WORK_TREE redirect it, and never prompts", async () => {
    const runner = new ScriptedRunner(() => ok());
    await new GitRepo("/x", runner).fetch();
    const { options } = runner.calls[runner.calls.length - 1]!;
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) assert.ok(options.removeEnv?.includes(name), name);
    assert.equal(options.env?.GIT_TERMINAL_PROMPT, "0");
  });

  it("makes ssh non-interactive when nothing else chose the ssh command", async () => {
    const saved = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      const runner = new ScriptedRunner((args) => (args[0] === "config" ? failed(1) : ok()));
      await new GitRepo("/x", runner).fetch();
      assert.equal(runner.calls[runner.calls.length - 1]!.options.env?.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
    } finally {
      if (saved !== undefined) process.env.GIT_SSH_COMMAND = saved;
    }
  });

  it("leaves the deployment's own ssh command (core.sshCommand with the deploy key) alone", async () => {
    const saved = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      const runner = new ScriptedRunner((args) => (args[0] === "config" ? ok("ssh -i /keys/deploy_ro -o IdentitiesOnly=yes\n") : ok()));
      await new GitRepo("/x", runner).fetch();
      assert.equal(runner.calls[runner.calls.length - 1]!.options.env?.GIT_SSH_COMMAND, undefined);
    } finally {
      if (saved !== undefined) process.env.GIT_SSH_COMMAND = saved;
    }
  });

  it("fetches without tags, submodules or a background gc, and only from origin", async () => {
    const runner = new ScriptedRunner(() => ok());
    await new GitRepo("/x", runner).fetch();
    const fetch = runner.calls.find((call) => call.args.includes("fetch"))!;
    assert.deepEqual(fetch.args, ["-c", "gc.auto=0", "fetch", "--prune", "--no-tags", "--no-recurse-submodules", "origin"]);
  });

  it("never sends anything to the remote", async () => {
    const runner = new ScriptedRunner(() => ok());
    const repo = new GitRepo("/x", runner);
    await repo.fetch();
    await repo.remoteBranches();
    await repo.pin(A_SHA);
    await repo.unpin(A_SHA);
    await repo.checkoutDetached(A_SHA);
    assert.ok(runner.calls.every((call) => !call.args.includes("push")));
  });

  it("refuses anything that is not a full commit id before running git", async () => {
    const runner = new ScriptedRunner(() => ok());
    const repo = new GitRepo("/x", runner);
    for (const bad of ["main", "--force", "", "abc", "A".repeat(40), `${A_SHA} `]) {
      await assert.rejects(repo.checkoutDetached(bad));
      await assert.rejects(repo.pin(bad));
    }
    assert.equal(runner.calls.length, 0);
  });
});

describe("GitRepo on a real repository", () => {
  const runner = new ExecCommandRunner();

  it("tells a clean tree from one with changes or untracked files, ignoring ignored files", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const repo = new GitRepo(fixture.runnerDir, runner);
    assert.equal(await repo.isClean(), true);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${fixture.runnerDir}/.env`, "ignored");
    assert.equal(await repo.isClean(), true, "ignored files do not count");
    writeFileSync(`${fixture.runnerDir}/stray.txt`, "x");
    assert.equal(await repo.isClean(), false);
  });

  it("finds the root of the working tree from a sub-folder", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const { mkdirSync, realpathSync } = await import("node:fs");
    mkdirSync(`${fixture.runnerDir}/e2e-testing`);
    const repo = new GitRepo(`${fixture.runnerDir}/e2e-testing`, runner);
    assert.equal(await repo.topLevel(), realpathSync.native(fixture.runnerDir));
  });

  it("removes nested git repositories left behind by a job", async () => {
    const fixture = new CatalogFixture(scratchDir());
    const repo = new GitRepo(fixture.runnerDir, runner);
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    mkdirSync(`${fixture.runnerDir}/leftover`);
    git(`${fixture.runnerDir}/leftover`, "init", "-q");
    writeFileSync(`${fixture.runnerDir}/leftover/file.txt`, "x");
    await repo.checkoutDetached(fixture.sha("main"));
    assert.equal(existsSync(`${fixture.runnerDir}/leftover`), false);
  });
});
