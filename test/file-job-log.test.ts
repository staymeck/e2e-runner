import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FileJobLog } from "../src/infra/file-job-log";
import { scratchDir } from "./helpers/workspace";

const root = scratchDir();

describe("FileJobLog", () => {
  it("appends text exactly as given, in order, to the job's own file", () => {
    const log = new FileJobLog(path.join(root, "a"));
    log.append("job-1", "first\n");
    log.append("job-1", "second\n");
    assert.equal(fs.readFileSync(log.pathOf("job-1"), "utf8"), "first\nsecond\n");
  });

  it("keeps one job's log separate from another's", () => {
    const log = new FileJobLog(path.join(root, "b"));
    log.append("job-1", "one");
    log.append("job-2", "two");
    assert.equal(fs.readFileSync(log.pathOf("job-1"), "utf8"), "one");
    assert.equal(fs.readFileSync(log.pathOf("job-2"), "utf8"), "two");
  });

  it("creates the folder on first use, not before", () => {
    const dir = path.join(root, "c", "nested");
    assert.ok(!fs.existsSync(dir));
    new FileJobLog(dir).append("job-1", "x");
    assert.ok(fs.existsSync(dir));
  });

  it("never throws when the folder cannot be created, and reports it instead", () => {
    const blocked = path.join(root, "a-file-not-a-dir");
    fs.writeFileSync(blocked, "not a directory");
    const warnings: Array<[object, string]> = [];
    const log = new FileJobLog(path.join(blocked, "logs"), { info: () => undefined, warn: (f, m) => warnings.push([f, m]), error: () => undefined });
    assert.doesNotThrow(() => log.append("job-1", "text"));
    assert.equal(warnings.length, 1);
    const [fields, message] = warnings[0]!;
    assert.match(message, /could not write to the job log/);
    assert.deepEqual((fields as { job: string }).job, "job-1");
  });

  it("refuses a job id that is not one path segment, instead of writing outside its folder", () => {
    // A backslash is not a path separator on POSIX, the only platforms this service deploys to: not tested here.
    for (const unsafe of ["../escaped", "a/b", "", ".", ".."]) {
      assert.throws(() => new FileJobLog(path.join(root, "d")).pathOf(unsafe), /Not a valid job id/);
    }
  });

  it("never throws for an unsafe job id either, and reports it instead", () => {
    const warnings: Array<[object, string]> = [];
    const log = new FileJobLog(path.join(root, "e"), { info: () => undefined, warn: (f, m) => warnings.push([f, m]), error: () => undefined });
    assert.doesNotThrow(() => log.append("../escaped", "text"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]![1], /could not write to the job log/);
    assert.ok(!fs.existsSync(path.join(root, "escaped.log")), "nothing must be written outside the log folder");
  });
});

describe("FileJobLog.read", () => {
  it("reads nothing for a job that has never logged anything", () => {
    const log = new FileJobLog(path.join(root, "f"));
    assert.deepEqual(log.read("ghost"), { text: "", nextFrom: 0 });
  });

  it("reads the whole log from the start by default", () => {
    const log = new FileJobLog(path.join(root, "g"));
    log.append("job-1", "hello world");
    assert.deepEqual(log.read("job-1"), { text: "hello world", nextFrom: 11 });
  });

  it("resumes from a byte offset, giving only what was appended since", () => {
    const log = new FileJobLog(path.join(root, "h"));
    log.append("job-1", "first");
    const first = log.read("job-1");
    log.append("job-1", "-second");
    const second = log.read("job-1", first.nextFrom);
    assert.deepEqual(second, { text: "-second", nextFrom: 12 });
  });

  it("reads nothing new when asked again at the current end", () => {
    const log = new FileJobLog(path.join(root, "i"));
    log.append("job-1", "hello");
    const first = log.read("job-1");
    assert.deepEqual(log.read("job-1", first.nextFrom), { text: "", nextFrom: first.nextFrom });
  });

  it("clamps an offset past the end instead of reading garbage or throwing", () => {
    const log = new FileJobLog(path.join(root, "j"));
    log.append("job-1", "hi");
    assert.deepEqual(log.read("job-1", 1000), { text: "", nextFrom: 2 });
  });

  it("clamps a negative offset to the start, instead of a position-dependent read", () => {
    const log = new FileJobLog(path.join(root, "j2"));
    log.append("job-1", "hi");
    assert.deepEqual(log.read("job-1", -5), { text: "hi", nextFrom: 2 });
  });

  it("never throws for an unsafe job id, reading as if nothing was logged", () => {
    const log = new FileJobLog(path.join(root, "k"));
    assert.deepEqual(log.read("../escaped"), { text: "", nextFrom: 0 });
    assert.deepEqual(log.read("../escaped", 5), { text: "", nextFrom: 5 });
  });

  it("round-trips non-ASCII text without corrupting it", () => {
    const log = new FileJobLog(path.join(root, "l"));
    log.append("job-1", "línea á 日本語 🙂");
    assert.equal(log.read("job-1").text, "línea á 日本語 🙂");
  });
});
