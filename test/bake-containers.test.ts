import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { CommandOptions, CommandRunner } from "../src/core/command-runner";
import { CommandFailedError } from "../src/core/command-runner";
import { DockerBakeContainers, JOB_LABEL } from "../src/adapters/detox/bake-containers";
import { ExecCommandRunner } from "../src/infra/exec-command-runner";

const IMAGE = "alpine:3.20";
const runner = new ExecCommandRunner();
const started: string[] = [];
after(async () => {
  if (started.length > 0) await runner.run("docker", ["rm", "-f", ...started], { cwd: "/", timeoutMs: 30_000 }).catch(() => undefined);
});

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function startContainer(jobId: string): Promise<string> {
  const { stdout } = await runner.run("docker", ["run", "-d", "--label", `${JOB_LABEL}=${jobId}`, IMAGE, "sleep", "300"], { cwd: "/", timeoutMs: 30_000 });
  const id = stdout.trim();
  started.push(id);
  return id;
}

async function isRunning(id: string): Promise<boolean> {
  const { stdout } = await runner.run("docker", ["inspect", "-f", "{{.State.Running}}", id], { cwd: "/", timeoutMs: 10_000 });
  return stdout.trim() === "true";
}

describe("DockerBakeContainers.stopForJob", () => {
  it("stops exactly the containers labelled for the job, and only them", async () => {
    const jobId = `job-${Date.now()}-a`;
    const other = `job-${Date.now()}-b`;
    const mine = await startContainer(jobId);
    const theirs = await startContainer(other);

    const containers = new DockerBakeContainers(runner, silent);
    const stopped = await containers.stopForJob(jobId);

    // `docker ps -q` reports short ids; `docker run` returned the full one.
    assert.equal(stopped.length, 1);
    assert.ok(mine.startsWith(stopped[0]!), `${mine} does not start with ${stopped[0]}`);
    assert.equal(await isRunning(mine), false);
    assert.equal(await isRunning(theirs), true);
  });

  it("is harmless, and returns nothing, when no container carries the job's label", async () => {
    const containers = new DockerBakeContainers(runner, silent);
    assert.deepEqual(await containers.stopForJob(`job-never-started-${Date.now()}`), []);
  });

  it("refuses an empty job id instead of matching every container", async () => {
    const fake: CommandRunner = {
      run: () => {
        throw new Error("must not be called for an empty job id");
      },
    };
    const containers = new DockerBakeContainers(fake, silent);
    assert.deepEqual(await containers.stopForJob(""), []);
    assert.deepEqual(await containers.stopForJob("   "), []);
  });

  it("reports, but does not throw, when docker cannot be reached", async () => {
    const warnings: Array<[object, string]> = [];
    const failing: CommandRunner = {
      run: (command: string, args: readonly string[], _options: CommandOptions) => {
        throw new CommandFailedError(command, args, null, "Cannot connect to the Docker daemon");
      },
    };
    const containers = new DockerBakeContainers(failing, { info: () => undefined, error: () => undefined, warn: (fields, message) => warnings.push([fields, message]) });
    const result = await containers.stopForJob("job-1");
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]![1], /could not stop the build containers/);
  });
});
