import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FileReportArchive } from "../src/adapters/detox/report-archive";
import { scratchDir } from "./helpers/workspace";

function silent() {
  const warnings: Array<[object, string]> = [];
  return { diagnostics: { info: () => undefined, warn: (f: object, m: string) => warnings.push([f, m]), error: () => undefined }, warnings };
}

describe("FileReportArchive", () => {
  it("copies the whole report folder (not just report.html), keyed by job id", () => {
    const root = scratchDir();
    const ephemeral = path.join(root, "ephemeral", "scenario-run-123");
    fs.mkdirSync(ephemeral, { recursive: true });
    fs.writeFileSync(path.join(ephemeral, "report.html"), "<html>ok</html>");
    fs.writeFileSync(path.join(ephemeral, "summary.json"), '{"total":1}');
    fs.mkdirSync(path.join(ephemeral, "screenshots"));
    fs.writeFileSync(path.join(ephemeral, "screenshots", "step-1.png"), "fakepng");

    const archive = new FileReportArchive(path.join(root, "reports"));
    const dest = archive.archive("job-1", ephemeral);

    assert.equal(dest, path.join(root, "reports", "job-1"));
    assert.equal(fs.readFileSync(path.join(dest!, "report.html"), "utf8"), "<html>ok</html>");
    assert.equal(fs.readFileSync(path.join(dest!, "summary.json"), "utf8"), '{"total":1}');
    assert.equal(fs.readFileSync(path.join(dest!, "screenshots", "step-1.png"), "utf8"), "fakepng");
  });

  it("survives the ephemeral folder being deleted afterwards — the whole point of archiving", () => {
    const root = scratchDir();
    const ephemeral = path.join(root, "ephemeral", "scenario-run-x");
    fs.mkdirSync(ephemeral, { recursive: true });
    fs.writeFileSync(path.join(ephemeral, "report.html"), "ok");

    const archive = new FileReportArchive(path.join(root, "reports"));
    const dest = archive.archive("job-2", ephemeral)!;
    fs.rmSync(ephemeral, { recursive: true, force: true }); // same effect as the next job's git clean -ffd

    assert.equal(fs.readFileSync(path.join(dest, "report.html"), "utf8"), "ok");
  });

  it("never throws, and returns undefined, for an unsafe job id or a missing source folder", () => {
    const root = scratchDir();
    const { diagnostics, warnings } = silent();
    const archive = new FileReportArchive(path.join(root, "reports"), diagnostics);

    assert.equal(archive.archive("../escape", path.join(root, "ephemeral")), undefined);
    assert.equal(archive.archive("job-3", path.join(root, "does-not-exist")), undefined);
    assert.equal(warnings.length, 2);
  });

  it("pathOf is deterministic and does not touch disk", () => {
    const root = scratchDir();
    const archive = new FileReportArchive(path.join(root, "reports"));
    assert.equal(archive.pathOf("job-4"), path.join(root, "reports", "job-4"));
    assert.throws(() => archive.pathOf(".."), /Not a valid job id/);
  });
});
