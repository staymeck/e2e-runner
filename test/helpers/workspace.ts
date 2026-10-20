import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";

/** A scratch directory removed when the test file finishes. */
export function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-runner-test-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeDir(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const VALID_KEY = "an-api-key-of-16+chars";

export const validProjects = {
  projects: {
    detox: {
      adapter: "detox",
      repo: "git@git.example.com:formos/detox-testing.git",
      allowedBranches: ["main", "iteration_*"],
      defaultBranch: "iteration_1",
    },
  },
};
