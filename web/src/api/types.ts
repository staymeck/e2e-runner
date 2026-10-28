/** Mirrors src/core/job.ts's literal unions; the web cannot import server code (a separate TS project). */
export type JobStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type Outcome = "success" | "warning" | "failure";
export type WebRole = "e2e-mobile" | "e2e-cypress" | "admin";

/** The only project this web supports today (Cypress has no project of its own yet). */
export const DETOX_PROJECT = "detox";

export interface PhaseView {
  readonly position: number;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outcome: Outcome | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Mirrors src/api/job-view.ts's `JobView` — what the API shows of a job. */
export interface JobView {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly ref: string;
  readonly sha: string;
  readonly target: string;
  readonly params: unknown;
  readonly locks: readonly string[];
  readonly retryOf: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  readonly phase: string | null;
  readonly phases: readonly PhaseView[];
  /** Beyond "something else is using its resource" — e.g. a job waiting on a disconnected device. */
  readonly waitingReason: string | null;
}

/** Mirrors src/core/adapter.ts's `DeviceStatus`. */
export interface DeviceStatus {
  readonly name: string;
  readonly state: "connected" | "disconnected" | "unauthorized";
}

export interface ProjectView {
  readonly id: string;
  readonly defaultBranch: string;
  readonly allowedBranches: readonly string[];
}

export interface CatalogTarget {
  readonly id: string;
  readonly title: string | null;
}

/** Mirrors src/core/adapter.ts's `ApkRowStatus`. */
export interface ApkRowStatus {
  readonly app: string;
  readonly branch: string;
  readonly ready: boolean;
  readonly customId?: string;
}

/** Mirrors src/core/adapter.ts's `ApkScenarioStatus`. `null` when the scenario has no plan at all yet. */
export interface ApkScenarioStatus {
  readonly scenarioId: string;
  readonly kind: string;
  readonly apps: readonly ApkRowStatus[];
}

export interface LoginResult {
  readonly token: string;
  readonly username: string;
  readonly role: WebRole;
}

export type MeResult = { readonly kind: "service" } | { readonly kind: "user"; readonly username: string; readonly role: WebRole };
