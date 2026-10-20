import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandFailedError, redactCredentials } from "../src/core/command-runner";
import { Mutex } from "../src/core/mutex";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";

const runner = new ExecCommandRunner();
const here = { cwd: process.cwd(), timeoutMs: 20_000 };

describe("ExecCommandRunner", () => {
  it("returns what the program printed", async () => {
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"], here);
    assert.deepEqual(result, { stdout: "hi", stderr: "warn" });
  });

  it("passes arguments literally: nothing is interpreted by a shell", async () => {
    const nasty = ["a; echo pwned", "$(whoami)", "`id`", "x && y", "--flag=value with spaces", "'quoted'", '"double"', "a|b", "*"];
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...nasty], here);
    assert.deepEqual(JSON.parse(result.stdout), nasty);
  });

  it("rejects with the exit code and the program's own message", async () => {
    await assert.rejects(runner.run(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], here), (error: unknown) => {
      assert.ok(error instanceof CommandFailedError);
      assert.equal(error.exitCode, 3);
      assert.match(error.message, /boom/);
      return true;
    });
  });

  it("kills a command that outlives its timeout", async () => {
    await assert.rejects(runner.run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { ...here, timeoutMs: 200 }), /timed out/);
  });

  it("rejects, not throws, for a program that does not exist", async () => {
    await assert.rejects(runner.run("definitely-not-a-program-xyz", [], here), CommandFailedError);
  });

  it("can start from a minimal environment, so third-party code never sees the service's secrets", async () => {
    process.env.E2E_TEST_SECRET_TOKEN = "super-secret-value";
    try {
      const script = "process.stdout.write(JSON.stringify({ secret: process.env.E2E_TEST_SECRET_TOKEN ?? null, path: Boolean(process.env.PATH || process.env.Path), added: process.env.ADDED ?? null }))";
      const minimal = await runner.run(process.execPath, ["-e", script], { ...here, minimalEnv: true, env: { ADDED: "yes" } });
      assert.deepEqual(JSON.parse(minimal.stdout), { secret: null, path: true, added: "yes" });
      const full = await runner.run(process.execPath, ["-e", script], here);
      assert.equal(JSON.parse(full.stdout).secret, "super-secret-value", "the default is unchanged");
    } finally {
      delete process.env.E2E_TEST_SECRET_TOKEN;
    }
  });

  it("can take variables out of the inherited environment", async () => {
    process.env.E2E_TEST_REDIRECT = "from-the-service";
    try {
      const result = await runner.run(process.execPath, ["-e", "process.stdout.write(String(process.env.E2E_TEST_REDIRECT))"], { ...here, removeEnv: ["E2E_TEST_REDIRECT"] });
      assert.equal(result.stdout, "undefined");
    } finally {
      delete process.env.E2E_TEST_REDIRECT;
    }
  });

  it("does not call an output overflow a timeout", async () => {
    await assert.rejects(runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(20 * 1024 * 1024))"], here), /size limit/);
  });

  it("adds to the environment without losing it", async () => {
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write(process.env.E2E_TEST_VALUE + '|' + (process.env.PATH ? 'path' : 'nopath'))"], { ...here, env: { E2E_TEST_VALUE: "set" } });
    assert.equal(result.stdout, "set|path");
  });
});

describe("CommandFailedError", () => {
  it("never repeats credentials that a tool echoed from a remote URL", () => {
    const error = new CommandFailedError("git", ["fetch"], 128, "fatal: unable to access 'https://user:hunter2@git.example.com/org/repo.git/': refused");
    assert.ok(!error.message.includes("hunter2"), error.message);
    assert.match(error.message, /https:\/\/\*\*\*@git\.example\.com/);
    assert.equal(redactCredentials("plain text without urls"), "plain text without urls");
  });
});

describe("Mutex", () => {
  it("runs tasks one at a time, in order", async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => mutex.run(async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name} end`);
    });
    await Promise.all([task("a", 30), task("b", 1), task("c", 1)]);
    assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("keeps going after a task fails, and still reports that failure to its caller", async () => {
    const mutex = new Mutex();
    const failing = mutex.run(async () => {
      throw new Error("nope");
    });
    const next = mutex.run(async () => "ok");
    await assert.rejects(failing, /nope/);
    assert.equal(await next, "ok");
  });

  it("returns each task's own value", async () => {
    const mutex = new Mutex();
    assert.deepEqual(await Promise.all([mutex.run(async () => 1), mutex.run(async () => "two")]), [1, "two"]);
  });
});
