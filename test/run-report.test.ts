import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { deriveOutcome, findRunReport, readRunSummary } from "../src/adapters/detox/run-report";
import { makeDir, scratchDir } from "./helpers/workspace";

const root = scratchDir();
let counter = 0;

function catalog(rc: unknown = { reportsDir: "reports" }): string {
  const dir = makeDir(root, `catalog-${counter++}`);
  if (rc !== undefined) fs.writeFileSync(path.join(dir, "orch.rc.json"), JSON.stringify(rc));
  return dir;
}

function runFolder(dir: string, stamp: string, summary?: unknown, folder = "reports"): string {
  const run = makeDir(dir, folder, `scenario-run-${stamp}`);
  if (summary !== undefined) fs.writeFileSync(path.join(run, "summary.json"), JSON.stringify(summary));
  return run;
}

describe("findRunReport", () => {
  it("finds the folder of the run that started after the given time", () => {
    const dir = catalog();
    const run = runFolder(dir, "2026-10-20T15-00-00-000Z");
    assert.equal(findRunReport(dir, Date.now() - 1000), run);
  });

  it("takes the newest of several, and never the shared latest-report.html", () => {
    const dir = catalog();
    runFolder(dir, "2026-10-20T15-00-00-000Z");
    const newest = runFolder(dir, "2026-10-20T16-00-00-000Z");
    fs.writeFileSync(path.join(dir, "reports", "latest-report.html"), "x");
    assert.equal(findRunReport(dir, Date.now() - 1000), newest);
  });

  it("ignores runs from before this one started", () => {
    const dir = catalog();
    const old = runFolder(dir, "2026-01-01T00-00-00-000Z");
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(old, past, past);
    assert.equal(findRunReport(dir, Date.now()), undefined);
  });

  it("returns nothing when there are no reports", () => {
    assert.equal(findRunReport(catalog(), 0), undefined);
  });

  it("follows the catalog's configured reports folder, and falls back to `reports`", () => {
    const custom = catalog({ reportsDir: "out/qa" });
    const run = runFolder(custom, "2026-10-20T15-00-00-000Z", undefined, path.join("out", "qa"));
    assert.equal(findRunReport(custom, 0), run);
    const broken = catalog(undefined);
    fs.writeFileSync(path.join(broken, "orch.rc.json"), "{nope");
    const fallback = runFolder(broken, "2026-10-20T15-00-00-000Z");
    assert.equal(findRunReport(broken, 0), fallback);
  });

  it("does not follow an absolute reports folder out of the catalog", () => {
    const dir = catalog({ reportsDir: path.join(root, "elsewhere") });
    runFolder(dir, "2026-10-20T15-00-00-000Z");
    assert.ok(findRunReport(dir, 0)?.startsWith(dir));
  });
});

describe("readRunSummary", () => {
  it("reads the counts", () => {
    const dir = catalog();
    const run = runFolder(dir, "a", { total: 3, passed: 2, failed: 1, skipped: 0, scenarios: [] });
    assert.deepEqual(readRunSummary(run), { total: 3, passed: 2, failed: 1, skipped: 0 });
  });

  it("treats missing or odd counts as zero, and a missing or broken file as no summary", () => {
    const dir = catalog();
    assert.deepEqual(readRunSummary(runFolder(dir, "b", { total: "many" })), { total: 0, passed: 0, failed: 0, skipped: 0 });
    assert.equal(readRunSummary(runFolder(dir, "c")), undefined);
    const broken = runFolder(dir, "d");
    fs.writeFileSync(path.join(broken, "summary.json"), "{nope");
    assert.equal(readRunSummary(broken), undefined);
  });
});

describe("deriveOutcome", () => {
  const summary = (failed: number, skipped: number) => ({ total: 3, passed: 3 - failed - skipped, failed, skipped });

  it("is decided by the exit code first", () => {
    assert.equal(deriveOutcome(0, undefined), "success");
    assert.equal(deriveOutcome(0, summary(0, 0)), "success");
    for (const code of [1, 2, 137, 143, null]) assert.equal(deriveOutcome(code, summary(0, 0)), "failure", String(code));
  });

  it("is a warning when it exited cleanly but skipped scenarios, a failure if any failed", () => {
    assert.equal(deriveOutcome(0, summary(0, 1)), "warning");
    assert.equal(deriveOutcome(0, summary(1, 0)), "failure");
    assert.equal(deriveOutcome(0, summary(1, 1)), "failure");
  });
});
