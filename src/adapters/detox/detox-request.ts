import type { JobRequestInput } from "../../core/adapter";
import { InvalidJobRequestError } from "../../core/job-request";

export const DETOX_KINDS = ["run", "build", "pipeline"] as const;
export type DetoxKind = (typeof DETOX_KINDS)[number];

export type PipelineScope = "all" | "batch" | "step";
const SCOPES: readonly string[] = ["all", "batch", "step"];

const MAX_ONLY = 20;
const APP_OR_SCENARIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A host name or an IPv4 address: what the devices connect back to. Never an option, never a URL. */
const WS_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** What `generate-apk-production` accepts, and nothing else. */
export interface BuildOptions {
  skipBuild?: boolean;
  noClone?: boolean;
  only?: string[];
  wsHost?: string;
}

export interface PipelineOptions extends BuildOptions {
  /** `false` runs the scenarios on the APKs already built. */
  build?: boolean;
}

export type DetoxParams = BuildOptions & PipelineOptions;

const BUILD_KEYS: readonly string[] = ["skipBuild", "noClone", "only", "wsHost"];
const PIPELINE_KEYS: readonly string[] = [...BUILD_KEYS, "build"];

function isDetoxKind(kind: string): kind is DetoxKind {
  return (DETOX_KINDS as readonly string[]).includes(kind);
}

function flag(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InvalidJobRequestError(`${key} must be true or false`);
  return value;
}

function names(params: Record<string, unknown>): string[] | undefined {
  const value = params.only;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ONLY) {
    throw new InvalidJobRequestError(`only must be a list of 1 to ${MAX_ONLY} app names`);
  }
  for (const name of value) {
    if (typeof name !== "string" || !APP_OR_SCENARIO_NAME.test(name)) throw new InvalidJobRequestError("only holds a name that is not a valid app name");
  }
  return [...new Set(value as string[])];
}

function wsHost(params: Record<string, unknown>): string | undefined {
  const value = params.wsHost;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WS_HOST.test(value)) throw new InvalidJobRequestError("wsHost must be a host name or an IP address");
  return value;
}

function build(params: Record<string, unknown>): BuildOptions {
  const result: BuildOptions = {};
  const skipBuild = flag(params, "skipBuild");
  const noClone = flag(params, "noClone");
  const only = names(params);
  const host = wsHost(params);
  if (skipBuild !== undefined) result.skipBuild = skipBuild;
  if (noClone !== undefined) result.noClone = noClone;
  if (only !== undefined) result.only = only;
  if (host !== undefined) result.wsHost = host;
  return result;
}

function asParams(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new InvalidJobRequestError("params must be an object");
  const params = raw as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new InvalidJobRequestError(allowed.length === 0 ? "this kind of job takes no params" : `unknown param "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
  return params;
}

/**
 * The Detox adapter's own check of a request, with a strict schema. What passes is what ends up on a command
 * line, so every value is either a flag or matches a pattern that cannot be taken for an option or a path.
 * Returns the parameters to store: only known keys, with defaults left out.
 */
export function validateDetoxRequest(request: JobRequestInput): DetoxParams {
  const { kind, target } = request;
  if (!isDetoxKind(kind)) throw new InvalidJobRequestError(`kind must be one of: ${DETOX_KINDS.join(", ")}`);

  if (kind === "run") {
    asParams(request.params, []);
    return {};
  }
  if (kind === "build") {
    if (target !== "all" && !APP_OR_SCENARIO_NAME.test(target)) throw new InvalidJobRequestError("target must be a scenario name or \"all\"");
    return build(asParams(request.params, BUILD_KEYS));
  }
  if (!SCOPES.includes(target)) throw new InvalidJobRequestError(`a pipeline's target must be one of: ${SCOPES.join(", ")}`);
  const params = asParams(request.params, PIPELINE_KEYS);
  const result: DetoxParams = build(params);
  const withBuild = flag(params, "build");
  if (withBuild !== undefined) result.build = withBuild;
  if (withBuild === false && Object.keys(result).some((key) => key !== "build")) {
    throw new InvalidJobRequestError("build options make no sense with build: false");
  }
  return result;
}

/** Phase names, in order, for a validated request. */
export function planDetoxPhases(request: { kind: string; params: unknown }): readonly string[] {
  if (request.kind === "run") return ["scenario"];
  if (request.kind === "build") return ["build"];
  return (request.params as DetoxParams | null)?.build === false ? ["scenario"] : ["build", "scenario"];
}

function buildFlags(options: BuildOptions): string[] {
  const flags: string[] = [];
  if (options.wsHost) flags.push("--ws-host", options.wsHost);
  if (options.skipBuild) flags.push("--skip-build");
  if (options.noClone) flags.push("--no-clone");
  for (const name of options.only ?? []) flags.push("--only", name);
  return flags;
}

/** The arguments `perfect-qa` gets for one phase of a validated job. */
export function detoxCliArgs(job: { kind: string; target: string; params: unknown }, phase: string): string[] {
  const params = (job.params ?? {}) as DetoxParams;
  if (job.kind === "run") return ["scenario", job.target, "--mode", "production"];
  if (job.kind === "build") {
    return ["generate-apk-production", ...(job.target === "all" ? [] : ["--scenario", job.target]), ...buildFlags(params)];
  }
  const scope = job.target === "all" ? [] : ["--kind", job.target];
  return phase === "build"
    ? ["generate-apk-production", ...scope, ...buildFlags(params)]
    : ["scenario", "--all", "--mode", "production", ...scope];
}

/** Whether the scenario named by a job has to exist in the catalog (a build of everything, or a pipeline, names none). */
export function namesAScenario(job: { kind: string; target: string }): boolean {
  return job.kind === "run" || (job.kind === "build" && job.target !== "all");
}
