import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogWorkspaces, Workspace } from "../../src/adapters/detox/catalog-workspaces";
import { RefNotFoundError } from "../../src/core/job-request";
import { makeDir } from "./workspace";

/**
 * A stand-in for the catalog's installed `perfect-qa`: same command line, behaviour chosen by environment
 * variables, so tests drive the real process handling (spawn, groups, signals) without devices or Docker.
 *
 *  FAKE_EXIT         exit code of `scenario` / `generate-apk-production` (default 0)
 *  FAKE_HANG=1       `scenario` never ends by itself: it handles SIGTERM by finishing with exit 143
 *  FAKE_IGNORE_TERM  with FAKE_HANG: ignores SIGTERM (only SIGKILL stops it)
 *  FAKE_SKIPPED      scenarios reported as skipped in summary.json
 *  FAKE_SCENARIOS    JSON list of scenario ids `scenarios` reports (default ["login","checkout"])
 *  FAKE_OLD=1        behaves like a catalog branch that predates the `scenarios` command
 */
const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env;
const cmd = args[0];

if (cmd === "scenarios") {
  if (env.FAKE_OLD) { console.error("error: unknown command 'scenarios'"); process.exit(1); }
  console.log("[orchestrator] loaded 2 scenario file(s): noise on stdout");
  const ids = JSON.parse(env.FAKE_SCENARIOS || '["login","checkout"]');
  // A real secret must never reach this process; "secret-visible" here would mean it did.
  const secretTitle = env.E2E_SERVICE_API_KEY ? "secret-visible" : null;
  const doc = { contractVersion: 1, scenarios: ids.map((id) => ({ id, kind: "step", title: secretTitle, description: null, apps: ["kpmake"], appRefs: [{ name: "kpmake", branch: "iteration_1" }] })) };
  const out = args[args.indexOf("--out") + 1];
  fs.writeFileSync(out, JSON.stringify(doc));
  process.exit(0);
}

console.log("cwd=" + process.cwd());
console.log("args=" + JSON.stringify(args));
console.log("job=" + env.PERFECT_QA_JOB_ID + " phase=" + env.PERFECT_QA_JOB_PHASE);
console.log("catalog=" + env.PERFECT_QA_ORIGINAL_DIR + " package=" + env.ORCH_PACKAGE_ROOT);
console.log("service-key-visible=" + Boolean(env.E2E_SERVICE_API_KEY));
console.error("a line on stderr");

function finish() {
  if (cmd === "scenario") {
    const folder = path.join(process.cwd(), "reports", "scenario-run-" + new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(folder, { recursive: true });
    const skipped = Number(env.FAKE_SKIPPED || 0);
    fs.writeFileSync(path.join(folder, "summary.json"), JSON.stringify({ total: 1 + skipped, passed: 1, failed: 0, skipped }));
  }
  process.exit(Number(env.FAKE_EXIT || 0));
}

if (cmd === "scenario" && env.FAKE_HANG) {
  console.log("hanging");
  if (env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
  else process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(143); });
  setInterval(() => {}, 1000);
} else {
  finish();
}
`;

/** Lays out a catalog folder with the fake `perfect-qa` where the real one lives. */
export function fakeCatalogDir(root: string, name: string): string {
  const dir = makeDir(root, name);
  const bin = path.join(dir, "node_modules", "@perfect", "e2e-orchestrator", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "perfect-qa.js"), SCRIPT);
  fs.writeFileSync(path.join(dir, "orch.rc.json"), JSON.stringify({ reportsDir: "reports" }));
  return dir;
}

/** A catalog that serves the one folder it was given and records what was asked of it. */
export class FakeCatalog implements CatalogWorkspaces {
  readonly prepared: string[] = [];
  readonly pinned: string[] = [];
  readonly released: string[] = [];
  prepareError: Error | undefined;

  constructor(
    private readonly dir: string,
    private readonly commits: Record<string, string> = { main: "a".repeat(40), iteration_1: "b".repeat(40) },
  ) {}

  async fetch(): Promise<void> {}
  async refs(): Promise<string[]> {
    return Object.keys(this.commits);
  }
  async browse(ref: string): Promise<Workspace> {
    return { dir: this.dir, sha: await this.pin(ref) };
  }
  async prepareRun(sha: string): Promise<Workspace> {
    this.prepared.push(sha);
    if (this.prepareError) throw this.prepareError;
    return { dir: this.dir, sha };
  }
  async prunePins(): Promise<number> {
    return 0;
  }
  async pin(ref: string): Promise<string> {
    const sha = this.commits[ref];
    if (!sha) throw new RefNotFoundError(ref);
    this.pinned.push(sha);
    return sha;
  }
  async release(sha: string): Promise<void> {
    this.released.push(sha);
  }
}
