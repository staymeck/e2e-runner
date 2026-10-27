import * as fs from "node:fs";
import type { PhaseResult, PhaseRun, RunContext, RunExecutor } from "../../core/adapter";
import { silentDiagnostics, type Diagnostics } from "../../core/diagnostics";
import type { JobLog } from "../../core/job-log";
import type { ProcessHost, RunningProcess } from "../../core/process-host";
import type { BakeContainers } from "./bake-containers";
import type { CatalogWorkspaces, Workspace } from "./catalog-workspaces";
import type { ApkStatusLister } from "./apk-status-checker";
import type { DeviceLister } from "./device-checker";
import { JOB_APK_PLAN_DIR, detoxCliArgs, namesAScenario, planDetoxPhases } from "./detox-request";
import { deriveOutcome, findRunReport, readRunSummary } from "./run-report";
import { orchestratorBin, orchestratorPackageRoot, type ScenarioLister } from "./scenario-lister";

/** After SIGTERM the process gets this long to finish its report before it is killed. */
export const DEFAULT_KILL_GRACE_MS = 8000;
const ORCHESTRATOR_BIN_NAME = "perfect-qa.js";

export interface DetoxExecutorDeps {
  readonly catalog: CatalogWorkspaces;
  readonly host: ProcessHost;
  readonly lister: ScenarioLister;
  /**
   * Not read by the executor itself — only by `createDetoxAdapter`, for `devices`/`canStart` (STA-46).
   * Optional: a test/fixture that does not care about device status does not need to stub it; omitting
   * it means the resulting adapter has no `devices`/`canStart` at all (not a default that silently
   * reports "zero devices" — that was tried and reverted, see `createDetoxAdapter`'s own comment).
   */
  readonly deviceLister?: DeviceLister;
  /**
   * Not read by the executor itself — only by `createDetoxAdapter`, for `apkStatus`/`checkReady`
   * (STA-48). Optional, same reasoning as `deviceLister`: omitting it means the resulting adapter has
   * no `apkStatus`/`checkReady` at all, not a default that silently reports "nothing is ready".
   */
  readonly apkStatusChecker?: ApkStatusLister;
  readonly containers: BakeContainers;
  readonly log: JobLog;
  /** The environment `perfect-qa` runs in (the service's, minus its own settings). Read at each start. */
  readonly environment: () => Readonly<Record<string, string>>;
  readonly diagnostics?: Diagnostics;
  readonly killGraceMs?: number;
}

/** What the executor remembers about a job between its phases. */
interface JobRun {
  workspace: Workspace | undefined;
  scenarioChecked: boolean;
  process: RunningProcess | undefined;
  exited: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

function failure(error: string, extra: Partial<PhaseResult> = {}): PhaseResult {
  return { exitCode: null, outcome: "failure", error, ...extra };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the phases of a Detox job by driving `perfect-qa` in the catalog's run folder, at the commit pinned when the
 * job was queued. One job at a time (the scheduler holds `devices`), so the run folder is never shared.
 */
export class DetoxExecutor implements RunExecutor {
  private readonly runs = new Map<string, JobRun>();
  private readonly diagnostics: Diagnostics;
  private readonly killGraceMs: number;

  constructor(private readonly deps: DetoxExecutorDeps) {
    this.diagnostics = deps.diagnostics ?? silentDiagnostics;
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  plan(request: { readonly kind: string; readonly target: string; readonly params: unknown }): readonly string[] {
    return planDetoxPhases(request);
  }

  async run(phase: PhaseRun, context: RunContext): Promise<PhaseResult> {
    const { job } = phase;
    const state = this.stateOf(job.id);
    const say = (text: string): void => this.deps.log.append(job.id, text);
    if (context.signal.aborted) return failure("Cancelled before it started");

    let workspace: Workspace;
    try {
      state.workspace ??= await this.deps.catalog.prepareRun(job.sha);
      workspace = state.workspace;
    } catch (error) {
      say(`[e2e-runner] could not prepare the catalog at ${job.sha}: ${describeError(error)}\n`);
      return failure(`Could not prepare the catalog at ${job.sha.slice(0, 12)}: ${describeError(error)}`);
    }
    if (context.signal.aborted) return failure("Cancelled before it started");

    if (!state.scenarioChecked && namesAScenario(job)) {
      const missing = await this.checkScenarioExists(job.target, workspace);
      if (missing) {
        say(`[e2e-runner] ${missing}\n`);
        return failure(missing);
      }
      state.scenarioChecked = true;
      if (context.signal.aborted) return failure("Cancelled before it started");
    }

    const bin = orchestratorBin(workspace.dir);
    if (!fs.existsSync(bin)) return failure(`The catalog has no installed orchestrator (${bin} is missing)`);

    const args = detoxCliArgs(job, phase.name);
    say(`\n===== phase ${phase.position + 1}: ${phase.name} (perfect-qa ${args.join(" ")}) =====\n`);
    const startedAt = Date.now();
    const running = this.deps.host.start(process.execPath, [bin, ...args], {
      cwd: workspace.dir,
      env: {
        ...this.deps.environment(),
        PERFECT_QA_ORIGINAL_DIR: workspace.dir,
        ORCH_CATALOG_ROOT: workspace.dir,
        ORCH_PACKAGE_ROOT: orchestratorPackageRoot(workspace.dir),
        // The run phase reads the APK plan from here too, not just the build phase that writes it
        // (via --out, in detox-request.ts's buildFlags) — both must agree, or a job's own build is
        // invisible to its own run. Set for every phase so neither can forget it.
        ORCH_APK_PRODUCTION_DIR: JOB_APK_PLAN_DIR,
        PERFECT_QA_JOB_ID: job.id,
        PERFECT_QA_JOB_PHASE: phase.name,
      },
      onOutput: say,
    });
    state.process = running;
    state.exited = false;

    const onAbort = (): void => this.terminate(state, "SIGTERM");
    if (running.pid !== undefined) {
      context.registerProcess(running.pid);
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener("abort", onAbort, { once: true });
    }

    const exit = await running.exit;
    state.exited = true;
    clearTimeout(state.killTimer);
    context.signal.removeEventListener("abort", onAbort);

    if (exit.spawnError !== undefined) return failure(`Could not start perfect-qa: ${exit.spawnError}`);

    const reportPath = phase.name === "scenario" ? findRunReport(workspace.dir, startedAt) : undefined;
    const summary = reportPath ? readRunSummary(reportPath) : undefined;
    const outcome = deriveOutcome(exit.code, summary);
    const error =
      context.signal.aborted ? "Cancelled" : exit.code === 0 ? undefined : exit.signal ? `perfect-qa was ended by ${exit.signal}` : `perfect-qa exited with code ${exit.code}`;
    say(`\n[e2e-runner] phase ${phase.name} ended: ${exit.signal ?? `exit code ${exit.code}`} (${outcome})\n`);
    return {
      exitCode: exit.code,
      outcome: context.signal.aborted && outcome !== "failure" ? "failure" : outcome,
      ...(exit.signal ? { signal: exit.signal } : {}),
      ...(error ? { error } : {}),
      ...(reportPath ? { reportPath } : {}),
    };
  }

  async cancel(jobId: string): Promise<void> {
    const state = this.runs.get(jobId);
    if (state) this.terminate(state, "SIGTERM");
    await this.deps.containers.stopForJob(jobId);
  }

  async cleanup(jobId: string, leftoverPid: number | null): Promise<void> {
    const state = this.runs.get(jobId);
    this.runs.delete(jobId);
    if (state) {
      clearTimeout(state.killTimer);
      this.terminate(state, "SIGKILL");
    }
    if (leftoverPid !== null) await this.killLeftover(jobId, leftoverPid);
    await this.deps.containers.stopForJob(jobId);
  }

  /**
   * A process the dead service had started. A process id can be reused once its owner is gone, so it is only
   * killed when it still is a `perfect-qa` run; if that cannot be told, it is left alone and reported.
   */
  private async killLeftover(jobId: string, pid: number): Promise<void> {
    const command = await this.deps.host.commandLine(pid);
    if (command === undefined) {
      this.diagnostics.warn({ job: jobId, pid }, "a process registered by the previous service run could not be checked: left alone");
      return;
    }
    if (!command.includes(ORCHESTRATOR_BIN_NAME)) return; // gone, and the id now belongs to something else
    this.diagnostics.warn({ job: jobId, pid }, "killing a perfect-qa process left by the previous service run");
    this.deps.host.kill(pid, "SIGKILL");
  }

  private terminate(state: JobRun, signal: NodeJS.Signals): void {
    const pid = state.process?.pid;
    if (pid === undefined || state.exited) return;
    this.deps.host.kill(pid, signal);
    if (signal === "SIGTERM" && state.killTimer === undefined) {
      state.killTimer = setTimeout(() => {
        if (!state.exited) this.deps.host.kill(pid, "SIGKILL");
      }, this.killGraceMs);
      state.killTimer.unref();
    }
  }

  private async checkScenarioExists(target: string, workspace: Workspace): Promise<string | undefined> {
    try {
      const scenarios = await this.deps.lister.list(workspace.dir);
      return scenarios.some((scenario) => scenario.id === target) ? undefined : `Scenario "${target}" does not exist in commit ${workspace.sha.slice(0, 12)}`;
    } catch (error) {
      return `Could not list the scenarios of commit ${workspace.sha.slice(0, 12)}: ${describeError(error)}`;
    }
  }

  private stateOf(jobId: string): JobRun {
    let state = this.runs.get(jobId);
    if (!state) {
      state = { workspace: undefined, scenarioChecked: false, process: undefined, exited: true, killTimer: undefined };
      this.runs.set(jobId, state);
    }
    return state;
  }
}
