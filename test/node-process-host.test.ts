import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";
import { NodeProcessHost } from "../src/infra/node-process-host";
import { scratchDir } from "./helpers/workspace";

const root = scratchDir();
const runner = new ExecCommandRunner();
const host = new NodeProcessHost(runner);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
    await sleep(25);
  }
}

/**
 * A hung child must fail the test, not the whole run: never await a real process's exit unguarded.
 * The timeout branch checks `settled` before throwing, so it never rejects after `promise` already won.
 */
async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let settled = false;
  const guarded = promise.finally(() => (settled = true));
  const timeout = sleep(timeoutMs).then((): T => {
    if (!settled) throw new Error(`timed out waiting for: ${label}`);
    return undefined as T;
  });
  return Promise.race([guarded, timeout]);
}

describe("NodeProcessHost.start", () => {
  it("runs the program and resolves exit with its code", async () => {
    const running = host.start(process.execPath, ["-e", "process.exit(7)"], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    assert.ok(typeof running.pid === "number");
    const exit = await running.exit;
    assert.deepEqual(exit, { code: 7, signal: null });
  });

  it("delivers stdout and stderr, interleaved, including non-ASCII text", async () => {
    let out = "";
    const script = "process.stdout.write('línea á\\n'); process.stderr.write('warn: 日本語\\n');";
    const running = host.start(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: (text) => (out += text) });
    await running.exit;
    assert.match(out, /línea á/);
    assert.match(out, /warn: 日本語/);
  });

  it("resolves with a spawnError instead of throwing when the program does not exist", async () => {
    const running = host.start("definitely-not-a-real-program-xyz", [], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    const exit = await running.exit;
    assert.equal(exit.code, null);
    assert.ok(exit.spawnError, "expected a spawnError");
  });

  it("never lets a throwing onOutput take the process down", async () => {
    const running = host.start(process.execPath, ["-e", "process.stdout.write('x')"], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      onOutput: () => {
        throw new Error("boom from the caller");
      },
    });
    const exit = await running.exit;
    assert.equal(exit.code, 0);
  });
});

describe("NodeProcessHost.kill", () => {
  it("sends the signal to a running process, which can react to it", async () => {
    const script = "process.on('SIGTERM', () => { process.stdout.write('got it'); process.exit(9); }); setInterval(() => {}, 1000);";
    const running = host.start(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    await sleep(150); // let the handler attach before the signal arrives
    host.kill(running.pid!, "SIGTERM");
    const exit = await withTimeout(running.exit, "the signalled process to exit");
    assert.deepEqual(exit, { code: 9, signal: null });
  });

  it("reaches a process the started one spawned itself, as the head of one process group", async () => {
    const marker = path.join(root, `group-${Date.now()}.pid`);
    const parentScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const running = host.start(process.execPath, ["-e", parentScript], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    try {
      await waitFor(() => fs.existsSync(marker), "the grandchild to register its pid");
      const grandchildPid = Number(fs.readFileSync(marker, "utf8"));
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

      host.kill(running.pid!, "SIGKILL");
      await withTimeout(running.exit, "the signalled parent to exit");
      await waitFor(() => !isAlive(grandchildPid), "the grandchild to die along with the group");
    } finally {
      // Nothing of this test's own is allowed to outlive it, whether or not an assertion above failed first.
      if (running.pid !== undefined && isAlive(running.pid)) host.kill(running.pid, "SIGKILL");
    }
  });

  it("does nothing, and does not throw, for a process that is already gone", async () => {
    const running = host.start(process.execPath, ["-e", "process.exit(0)"], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    await running.exit;
    assert.doesNotThrow(() => host.kill(running.pid!, "SIGTERM"));
  });
});

describe("NodeProcessHost.commandLine", () => {
  it("reports the command line of a running process", async () => {
    const marker = `e2e-runner-command-line-test-${Date.now()}`;
    const running = host.start(process.execPath, ["-e", "setInterval(() => {}, 1000);", marker], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      onOutput: () => undefined,
    });
    try {
      const line = await host.commandLine(running.pid!);
      assert.ok(line?.includes(marker), line);
    } finally {
      host.kill(running.pid!, "SIGKILL");
      await running.exit;
    }
  });

  it("reports nothing for a pid that does not exist", async () => {
    const running = host.start(process.execPath, ["-e", "process.exit(0)"], { cwd: process.cwd(), env: process.env as Record<string, string>, onOutput: () => undefined });
    const pid = running.pid!;
    await running.exit;
    await sleep(50);
    assert.equal(await host.commandLine(pid), undefined);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
