import * as fs from "node:fs";
import * as path from "node:path";
import { DETOX_ADAPTER, loadDetoxConfig, type DetoxConfig } from "../adapters/detox/detox-config";
import { isBranchAllowed, isValidBranchPattern } from "../core/branch-pattern";
import { ConfigError, Problems } from "./problems";
import type { ProjectConfig, ServiceConfig } from "./service-config";

export const MIN_API_KEY_LENGTH = 16;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;
const PROJECT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const KNOWN_ADAPTERS: readonly string[] = [DETOX_ADAPTER];

export type ReadTextFile = (file: string) => string;

const readUtf8: ReadTextFile = (file) => fs.readFileSync(file, "utf8");

function readApiKeys(env: NodeJS.ProcessEnv, problems: Problems): string[] {
  const keys: string[] = [];
  for (const name of ["E2E_SERVICE_API_KEY", "E2E_SERVICE_API_KEY_NEXT"]) {
    const value = env[name]?.trim();
    if (!value) {
      if (name === "E2E_SERVICE_API_KEY") problems.add(`${name} is required: the service does not start without an API key`);
      continue;
    }
    if (value.length < MIN_API_KEY_LENGTH) {
      problems.add(`${name} must be at least ${MIN_API_KEY_LENGTH} characters long`);
      continue;
    }
    keys.push(value);
  }
  if (keys.length === 2 && keys[0] === keys[1]) {
    problems.add("E2E_SERVICE_API_KEY_NEXT must differ from E2E_SERVICE_API_KEY");
  }
  return keys;
}

function readServer(env: NodeJS.ProcessEnv, problems: Problems): ServiceConfig["server"] {
  const host = env.E2E_SERVICE_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.E2E_SERVICE_PORT?.trim();
  let port = DEFAULT_PORT;
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.add(`E2E_SERVICE_PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
      port = DEFAULT_PORT;
    }
  }
  return { host, port };
}

function readAbsoluteDir(env: NodeJS.ProcessEnv, name: string, problems: Problems): string {
  const value = env[name]?.trim();
  if (!value) {
    problems.add(`${name} is required`);
    return "";
  }
  if (!path.isAbsolute(value)) {
    problems.add(`${name} must be an absolute path (got "${value}")`);
    return "";
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readProject(id: string, raw: unknown, problems: Problems): ProjectConfig | undefined {
  const where = `projects.${id}`;
  const entry = asRecord(raw);
  if (!entry) {
    problems.add(`${where} must be an object`);
    return undefined;
  }
  const before = problems.list.length;
  if (!PROJECT_ID.test(id)) problems.add(`${where}: the id must match ${PROJECT_ID}`);

  const adapter = entry.adapter;
  if (typeof adapter !== "string" || !KNOWN_ADAPTERS.includes(adapter)) {
    problems.add(`${where}.adapter must be one of: ${KNOWN_ADAPTERS.join(", ")}`);
  }
  const repo = entry.repo;
  if (typeof repo !== "string" || repo.trim() === "") problems.add(`${where}.repo must be a non-empty string`);

  const patterns = entry.allowedBranches;
  const validPatterns =
    Array.isArray(patterns) && patterns.length > 0 && patterns.every((p) => typeof p === "string" && isValidBranchPattern(p));
  if (!validPatterns) problems.add(`${where}.allowedBranches must be a non-empty list of branch patterns (letters, digits, . _ - / and *)`);

  const defaultBranch = entry.defaultBranch;
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    problems.add(`${where}.defaultBranch must be a non-empty string`);
  } else if (validPatterns && !isBranchAllowed(patterns as string[], defaultBranch)) {
    problems.add(`${where}.defaultBranch "${defaultBranch}" is not matched by allowedBranches`);
  }

  if (problems.list.length > before) return undefined;
  return {
    id,
    adapter: adapter as string,
    repo: (repo as string).trim(),
    allowedBranches: patterns as string[],
    defaultBranch: defaultBranch as string,
  };
}

function readProjects(env: NodeJS.ProcessEnv, readFile: ReadTextFile, problems: Problems): ProjectConfig[] {
  const file = env.E2E_SERVICE_CONFIG?.trim();
  if (!file) {
    problems.add("E2E_SERVICE_CONFIG is required (path to the projects JSON file)");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(file));
  } catch (error) {
    problems.add(`E2E_SERVICE_CONFIG could not be read as JSON (${file}): ${(error as Error).message}`);
    return [];
  }
  const projects = asRecord(asRecord(parsed)?.projects);
  if (!projects || Object.keys(projects).length === 0) {
    problems.add(`${file}: "projects" must be an object with at least one project`);
    return [];
  }
  const result: ProjectConfig[] = [];
  for (const [id, raw] of Object.entries(projects)) {
    const project = readProject(id, raw, problems);
    if (project) result.push(project);
  }
  return result;
}

/**
 * Builds the service configuration from the environment and the projects file.
 * Throws a ConfigError listing every problem found, never just the first.
 */
export function loadConfig(env: NodeJS.ProcessEnv, readFile: ReadTextFile = readUtf8): ServiceConfig {
  const problems = new Problems();
  const apiKeys = readApiKeys(env, problems);
  const server = readServer(env, problems);
  const dataDir = readAbsoluteDir(env, "E2E_SERVICE_DATA_DIR", problems);
  const projects = readProjects(env, readFile, problems);

  let detox: DetoxConfig | undefined;
  if (projects.some((project) => project.adapter === DETOX_ADAPTER)) {
    detox = loadDetoxConfig(env, problems);
  }

  if (problems.any) throw new ConfigError(problems.list);
  return { server, apiKeys, dataDir, projects, detox };
}
