import { JOB_STATUSES, type JobFilter, type JobPage, type JobStatus } from "../core/job";
import { InvalidJobRequestError } from "../core/job-request";
import type { SubmitJob } from "../core/job-service";

const MAX_TEXT = 255;
const KNOWN_BODY_KEYS: readonly string[] = ["project", "ref", "kind", "target", "params"];

function text(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new InvalidJobRequestError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") throw new InvalidJobRequestError(`${field} must be a non-empty string`);
  if (value.length > MAX_TEXT) throw new InvalidJobRequestError(`${field} is too long`);
  return value;
}

/** Validates the body of POST /v1/jobs. Unknown fields are rejected so a typo is not silently ignored. */
export function parseSubmit(body: unknown): SubmitJob {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new InvalidJobRequestError("the body must be a JSON object");
  const fields = body as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!KNOWN_BODY_KEYS.includes(key)) throw new InvalidJobRequestError(`unknown field "${key}"`);
  }
  const ref = text(fields.ref, "ref", false);
  const kind = text(fields.kind, "kind", false);
  return {
    project: text(fields.project, "project", true) as string,
    target: text(fields.target, "target", true) as string,
    ...(ref === undefined ? {} : { ref }),
    ...(kind === undefined ? {} : { kind }),
    ...(fields.params === undefined ? {} : { params: fields.params }),
  };
}

function one(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidJobRequestError(`${field} must be given once`);
  return text(value, field, false);
}

function integer(value: unknown, field: string, min: number): number | undefined {
  const raw = one(value, field);
  if (raw === undefined) return undefined;
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < min) throw new InvalidJobRequestError(`${field} must be a whole number of at least ${min}`);
  return Number(raw);
}

/** Validates the query of GET /v1/jobs: filters, `limit` and the `before` cursor. */
export function parseList(query: Record<string, unknown>): { filter: JobFilter; page: JobPage } {
  const project = one(query.project, "project");
  const ref = one(query.ref, "ref");
  const target = one(query.target, "target");
  const limit = integer(query.limit, "limit", 1);
  const before = integer(query.before, "before", 1);

  const statuses = parseStatuses(query.status);
  return {
    filter: {
      ...(project === undefined ? {} : { project }),
      ...(ref === undefined ? {} : { ref }),
      ...(target === undefined ? {} : { target }),
      ...(statuses === undefined ? {} : { statuses }),
    },
    page: { ...(limit === undefined ? {} : { limit }), ...(before === undefined ? {} : { before }) },
  };
}

/** `status=queued,running` or `status=queued&status=running`. */
function parseStatuses(value: unknown): JobStatus[] | undefined {
  if (value === undefined) return undefined;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    if (typeof entry !== "string") throw new InvalidJobRequestError("status must be text");
    return entry.split(",");
  });
  const unknown = parts.filter((part) => !(JOB_STATUSES as readonly string[]).includes(part));
  if (unknown.length > 0) throw new InvalidJobRequestError(`unknown status: ${unknown.join(", ")} (use: ${JOB_STATUSES.join(", ")})`);
  return parts as JobStatus[];
}
