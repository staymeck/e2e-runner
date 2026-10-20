import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MissingLockfileError, NpmInstaller } from "../src/adapters/detox/dependency-installer";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/core/command-runner";
import { makeDir, scratchDir } from "./helpers/workspace";

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  fail: Error | undefined;

  async run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    if (this.fail) throw this.fail;
    fs.mkdirSync(path.join(options.cwd, "node_modules"), { recursive: true }); // npm ci creates it
    return { stdout: "", stderr: "" };
  }
}

const root = scratchDir();
let counter = 0;
function catalogDir(lock = '{"v":1}'): string {
  const dir = makeDir(root, `catalog-${counter++}`);
  fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
  return dir;
}

describe("NpmInstaller", () => {
  it("runs `npm ci` once for a new tree, with no shell and from the folder", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    assert.equal(await new NpmInstaller(runner, "v22.1.0").ensure(dir), true);
    assert.deepEqual(runner.calls.map((c) => [c.command, c.args[0], c.cwd]), [["npm", "ci", dir]]);
  });

  it("does nothing the second time", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    const installer = new NpmInstaller(runner, "v22.1.0");
    await installer.ensure(dir);
    assert.equal(await installer.ensure(dir), false);
    assert.equal(runner.calls.length, 1);
  });

  it("installs again when the lockfile changes", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    const installer = new NpmInstaller(runner, "v22.1.0");
    await installer.ensure(dir);
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"v":2}');
    assert.equal(await installer.ensure(dir), true);
    assert.equal(runner.calls.length, 2);
  });

  it("installs again when the Node version changes", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    await new NpmInstaller(runner, "v22.1.0").ensure(dir);
    assert.equal(await new NpmInstaller(runner, "v24.0.0").ensure(dir), true);
  });

  it("installs again when node_modules was deleted", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    const installer = new NpmInstaller(runner, "v22.1.0");
    await installer.ensure(dir);
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
    assert.equal(await installer.ensure(dir), true);
  });

  it("does not remember a failed install: the next job tries again", async () => {
    const runner = new FakeRunner();
    const dir = catalogDir();
    const installer = new NpmInstaller(runner, "v22.1.0");
    runner.fail = new Error("registry down");
    await assert.rejects(installer.ensure(dir), /registry down/);
    runner.fail = undefined;
    assert.equal(await installer.ensure(dir), true);
  });

  it("refuses a catalog without a lockfile instead of installing whatever is latest", async () => {
    const dir = makeDir(root, "no-lock");
    await assert.rejects(new NpmInstaller(new FakeRunner()).ensure(dir), MissingLockfileError);
  });
});
