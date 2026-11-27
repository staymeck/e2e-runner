import * as fs from "node:fs";
import * as path from "node:path";
import type { Outcome } from "../../core/job";

const RUN_FOLDER = /^scenario-run-/;
const DEFAULT_REPORTS_DIR = "reports";
/** Files may be stamped a moment before the process started: file systems round times. */
const CLOCK_SLACK_MS = 2000;

/** One catalog scenario's own result within a run — a "run" job's summary always has exactly one, a "pipeline" job's can have many. */
export interface ScenarioOutcome {
  readonly id: string;
  readonly outcome: Outcome;
}

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly scenarios: readonly ScenarioOutcome[];
}

function reportsDir(catalogDir: string): string {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(catalogDir, "orch.rc.json"), "utf8")) as { reportsDir?: unknown };
    if (typeof rc.reportsDir === "string" && rc.reportsDir.trim() && !path.isAbsolute(rc.reportsDir)) return path.join(catalogDir, rc.reportsDir);
  } catch {
    // no readable orch.rc.json: the default
  }
  return path.join(catalogDir, DEFAULT_REPORTS_DIR);
}

/**
 * The folder the production run that started at `sinceMs` wrote its report to (`reports/scenario-run-<stamp>/`),
 * or undefined if there is none. The newest one wins, and `latest-report.html` is never used: it may belong to
 * another run.
 */
export function findRunReport(catalogDir: string, sinceMs: number): string | undefined {
  const root = reportsDir(catalogDir);
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((name) => RUN_FOLDER.test(name));
  } catch {
    return undefined;
  }
  const candidates = names
    .map((name) => path.join(root, name))
    .filter((folder) => {
      try {
        return fs.statSync(folder).mtimeMs >= sinceMs - CLOCK_SLACK_MS;
      } catch {
        return false;
      }
    })
    .sort();
  return candidates[candidates.length - 1];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** perfect-qa's own per-scenario status; anything else (a future status this build doesn't know yet) is dropped, not guessed at. */
function scenarioOutcome(status: unknown): Outcome | undefined {
  if (status === "passed") return "success";
  if (status === "failed") return "failure";
  if (status === "skipped") return "warning";
  return undefined;
}

/**
 * `summary.json`'s own `scenarios` array, already flat regardless of how many apps/steps one catalog
 * scenario fanned out to internally — each entry here is one catalog scenario id. Malformed or
 * unrecognized entries are dropped rather than failing the whole summary over them.
 */
function scenarios(value: unknown): ScenarioOutcome[] {
  if (!Array.isArray(value)) return [];
  const result: ScenarioOutcome[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, status } = entry as Record<string, unknown>;
    const outcome = scenarioOutcome(status);
    if (typeof id === "string" && id !== "" && outcome !== undefined) result.push({ id, outcome });
  }
  return result;
}

export function readRunSummary(reportDir: string): RunSummary | undefined {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(reportDir, "summary.json"), "utf8")) as Record<string, unknown>;
    return {
      total: count(summary.total),
      passed: count(summary.passed),
      failed: count(summary.failed),
      skipped: count(summary.skipped),
      scenarios: scenarios(summary.scenarios),
    };
  } catch {
    return undefined;
  }
}

/**
 * What a finished `perfect-qa` phase means. The exit code decides pass or fail; a run that exited cleanly but whose
 * summary still counts skipped scenarios is only a warning (they did not run, so they proved nothing).
 */
export function deriveOutcome(exitCode: number | null, summary: RunSummary | undefined): Outcome {
  if (exitCode !== 0) return "failure";
  if (summary && (summary.failed > 0 || summary.skipped > 0)) return summary.failed > 0 ? "failure" : "warning";
  return "success";
}
