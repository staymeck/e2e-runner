import type { CommandRunner } from "../../core/command-runner";
import type { Diagnostics } from "../../core/diagnostics";

const DOCKER_TIMEOUT_MS = 60_000;
/** `build-apk.py` labels the containers it starts with this, so one job's can be told from another's. */
export const JOB_LABEL = "perfect.qa.job_id";

/** The Docker containers that compile APKs for one job. */
export interface BakeContainers {
  /** Stops the containers labelled for this job, and only them. Never throws. Returns the ids stopped. */
  stopForJob(jobId: string): Promise<string[]>;
}

export class DockerBakeContainers implements BakeContainers {
  constructor(
    private readonly runner: CommandRunner,
    private readonly diagnostics: Diagnostics,
  ) {}

  async stopForJob(jobId: string): Promise<string[]> {
    if (!jobId.trim()) return []; // an empty label would match every job's containers
    try {
      const listed = await this.runner.run("docker", ["ps", "-q", "--filter", `label=${JOB_LABEL}=${jobId}`], { cwd: "/", timeoutMs: DOCKER_TIMEOUT_MS });
      const ids = listed.stdout.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/i.test(id));
      if (ids.length === 0) return [];
      await this.runner.run("docker", ["stop", "-t", "5", ...ids], { cwd: "/", timeoutMs: DOCKER_TIMEOUT_MS });
      return ids;
    } catch (error) {
      // no docker, daemon down: nothing to stop that we could reach
      this.diagnostics.warn({ job: jobId, error: error instanceof Error ? error.message : String(error) }, "could not stop the build containers");
      return [];
    }
  }
}
