import type { Job, JobPhase, Outcome, ReportScope } from "../core/job";
import { createWebhookEventId } from "./sign";

/**
 * Adapted from the orchestrator's `api/webhook/payload.ts`, not ported verbatim: its job model had no
 * structured outcome or phase status (both were derived by scanning `reports.json`/`summary.json` on
 * disk), and every link carried a long-lived `accessToken` query param this service has no equivalent
 * of. This service's `Job`/`JobPhase` already carry `outcome` and phase status directly, so
 * `deriveOutcome` and the reports-file scanning it depended on are simply not needed here — n8n reads
 * the same information from fields that are already correct, not reconstructed from files.
 *
 * Documented differences from the orchestrator's payload (ticket allows this instead of an exact port):
 * - No `label` field (the orchestrator's human-readable job label has no equivalent here).
 * - `links.log` has no `?token=`: this service has no long-lived access token for it. A caller (n8n)
 *   reaches it with its own `Authorization: Bearer` API key, the same as every other route.
 * - `links.report` (STA-54) carries a `?ticket=` instead of the orchestrator's `?token=`: an
 *   `ArtifactTickets` entry, reusable across multiple opens over its own TTL rather than a stored,
 *   manually-rotated per-job secret — see that class's own doc for why. Present only when the caller
 *   passes one; omitted (not a bare, unusable link) otherwise.
 * - `links.report` points at the *general* report's public page by default (`job.reportScope`,
 *   `"general"` unless the submitter asked for `"job"`) — the shared, always-current link for the
 *   whole tracked branch, not this one job's own report. `reportTicket` (this job's own) is still
 *   issued and still available via `GET .../jobs/:id/report` regardless of scope; only which one
 *   `links.report` surfaces changes.
 */
export type WebhookEvent = "started" | "finished";
export type WebhookJobType = "scenario" | "build" | "pipeline";

export interface WebhookPhaseResult {
  readonly name: string;
  readonly status: JobPhase["status"];
  readonly outcome: Outcome | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface WebhookJobLinks {
  readonly job: string;
  readonly log: string;
  readonly report?: string;
}

export interface WebhookPayload {
  readonly event: WebhookEvent;
  readonly eventId: string;
  readonly timestamp: number;
  readonly jobId: string;
  readonly project: string;
  readonly type: WebhookJobType;
  readonly target: string;
  readonly ref: string;
  readonly sha: string;
  readonly phase: string | null;
  readonly phaseIndex: number | null;
  readonly phaseTotal: number;
  readonly jobStatus: Job["status"];
  readonly outcome: Outcome | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly phases: readonly WebhookPhaseResult[];
  readonly links: WebhookJobLinks;
}

/** Kept for n8n compatibility: it already reads `type: "scenario"` for what this service calls `kind: "run"`. */
export function toWebhookJobType(kind: Job["kind"]): WebhookJobType {
  if (kind === "run") return "scenario";
  if (kind === "build") return "build";
  return "pipeline";
}

/**
 * `reportScope` picks which of the two tickets `links.report` is built from: `"general"` (default)
 * uses `generalReportTicket` and points at the shared public page; `"job"` uses `reportTicket` and
 * points at this job's own report, exactly as before this field existed. Either ticket being absent
 * (not yet issued, or the job has no report at all) falls back to omitting `links.report` entirely,
 * not a bare, unusable link.
 */
export function buildJobLinks(baseUrl: string, jobId: string, reportScope: ReportScope, reportTicket?: string, generalReportTicket?: string): WebhookJobLinks {
  const base = baseUrl.replace(/\/+$/, "");
  const links = { job: `${base}/v1/jobs/${jobId}`, log: `${base}/v1/jobs/${jobId}/log` };
  if (reportScope === "general" && generalReportTicket) {
    return { ...links, report: `${base}/v1/report/general/html?ticket=${encodeURIComponent(generalReportTicket)}` };
  }
  if (reportScope === "job" && reportTicket) {
    return { ...links, report: `${base}/v1/jobs/${jobId}/report?ticket=${encodeURIComponent(reportTicket)}` };
  }
  return links;
}

function toPhaseResult(phase: JobPhase): WebhookPhaseResult {
  return { name: phase.name, status: phase.status, outcome: phase.outcome, exitCode: phase.exitCode, signal: phase.signal };
}

function durationOf(startedAt: string | null, finishedAt: string | null): number | null {
  // No separate null check needed: Date.parse("") is already NaN, and NaN propagates through the
  // subtraction, so a missing date falls straight into the Number.isFinite guard below.
  const ms = Date.parse(finishedAt ?? "") - Date.parse(startedAt ?? "");
  return Number.isFinite(ms) ? ms : null;
}

export interface BuildWebhookPayloadOptions {
  readonly event: WebhookEvent;
  readonly job: Job;
  /** Name of the phase that triggered this event, or null for a job-level event. */
  readonly phase: string | null;
  readonly phaseIndex: number | null;
  /** Origin this service's own API is reachable at, for `links` (no trailing slash needed). */
  readonly baseUrl: string;
  /** Forwarded to `buildJobLinks`: an `ArtifactTickets` entry for this job, if the caller has one. */
  readonly reportTicket?: string;
  /** Forwarded to `buildJobLinks`: an `ArtifactTickets` entry for `GENERAL_REPORT_TICKET_SUBJECT`. */
  readonly generalReportTicket?: string;
  readonly eventId?: string;
  readonly timestamp?: number;
}

export function buildWebhookPayload(opts: BuildWebhookPayloadOptions): WebhookPayload {
  const { job } = opts;
  return {
    event: opts.event,
    eventId: opts.eventId ?? createWebhookEventId(),
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    jobId: job.id,
    project: job.project,
    type: toWebhookJobType(job.kind),
    target: job.target,
    ref: job.ref,
    sha: job.sha,
    phase: opts.phase,
    phaseIndex: opts.phaseIndex,
    phaseTotal: job.phases.length,
    jobStatus: job.status,
    outcome: job.outcome,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: durationOf(job.startedAt, job.finishedAt),
    error: job.error,
    phases: job.phases.map(toPhaseResult),
    links: buildJobLinks(opts.baseUrl, job.id, job.reportScope, opts.reportTicket, opts.generalReportTicket),
  };
}
