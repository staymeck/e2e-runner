import { randomUUID } from "node:crypto";
import {
  InvalidDetailsError,
  InvalidPhaseTransitionError,
  InvalidTransitionError,
  JobNotActiveError,
  JobNotFoundError,
  RetryNotAllowedError,
  canPhaseTransition,
  canTransition,
  isActive,
  isTerminal,
  type Job,
  type JobFilter,
  type JobList,
  type JobPage,
  type JobPhase,
  type JobStatus,
  type NewJob,
  type Outcome,
  type PhaseStatus,
  type PhaseUpdate,
  type TransitionDetails,
} from "../core/job";
import type { JobStore } from "../core/job-store";
import type { Database, Row, SqlValue } from "./database";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const FINISHED_PHASE: readonly PhaseStatus[] = ["succeeded", "failed", "skipped", "cancelled"];

export interface SqliteJobStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function toPhase(row: Row): JobPhase {
  return {
    position: Number(row.position),
    name: row.name as string,
    status: row.status as PhaseStatus,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    signal: row.signal as string | null,
    outcome: row.outcome as Outcome | null,
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
  };
}

function toJob(row: Row, phases: readonly JobPhase[]): Job {
  return {
    seq: Number(row.seq),
    id: row.id as string,
    project: row.project as string,
    kind: row.kind as string,
    status: row.status as JobStatus,
    ref: row.ref as string,
    sha: row.sha as string,
    target: row.target as string,
    params: JSON.parse(row.params as string),
    locks: JSON.parse(row.locks as string) as string[],
    retryOf: row.retry_of as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
    cancelRequestedAt: row.cancel_requested_at as string | null,
    outcome: row.outcome as Outcome | null,
    error: row.error as string | null,
    pid: row.pid === null ? null : Number(row.pid),
    logPath: row.log_path as string | null,
    reportPath: row.report_path as string | null,
    phases,
  };
}

function pageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
}

/** Jobs stored in SQLite. Every write that touches more than one row is one transaction. */
export class SqliteJobStore implements JobStore {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: Database,
    options: SqliteJobStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  create(job: NewJob): Job {
    const id = this.newId();
    const createdAt = this.now().toISOString();
    this.db.transaction(() => {
      if (job.retryOf !== undefined) this.assertRetryable(job.retryOf);
      this.db.run(
        `INSERT INTO jobs (id, project, kind, status, ref, sha, target, params, locks, retry_of, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        job.project,
        job.kind,
        job.ref,
        job.sha,
        job.target,
        JSON.stringify(job.params ?? null),
        JSON.stringify(job.locks),
        job.retryOf ?? null,
        createdAt,
      );
      job.phases.forEach((name, position) => {
        this.db.run("INSERT INTO job_phases (job_id, position, name, status) VALUES (?, ?, ?, 'pending')", id, position, name);
      });
    });
    return this.require(id);
  }

  get(id: string): Job | undefined {
    const row = this.db.get("SELECT * FROM jobs WHERE id = ?", id);
    return row ? toJob(row, this.phasesOf([id]).get(id) ?? []) : undefined;
  }

  list(filter: JobFilter = {}, page: JobPage = {}): JobList {
    const limit = pageSize(page.limit);
    const where: string[] = [];
    const params: SqlValue[] = [];
    const require = (clause: string, ...values: SqlValue[]): void => {
      where.push(clause);
      params.push(...values);
    };
    if (filter.project !== undefined) require("project = ?", filter.project);
    if (filter.ref !== undefined) require("ref = ?", filter.ref);
    if (filter.target !== undefined) require("target = ?", filter.target);
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return { jobs: [], nextCursor: null };
      require(`status IN (${filter.statuses.map(() => "?").join(", ")})`, ...filter.statuses);
    }
    if (page.before !== undefined) require("seq < ?", page.before);

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // one extra row tells whether there is a next page without a second query
    const rows = this.db.all(`SELECT * FROM jobs ${clause} ORDER BY seq DESC LIMIT ?`, ...params, limit + 1);
    const hasMore = rows.length > limit;
    const jobs = this.hydrate(rows.slice(0, limit));
    return { jobs, nextCursor: hasMore ? (jobs[jobs.length - 1]?.seq ?? null) : null };
  }

  listByStatus(status: JobStatus): readonly Job[] {
    return this.hydrate(this.db.all("SELECT * FROM jobs WHERE status = ? ORDER BY seq ASC", status));
  }

  listActive(): readonly Job[] {
    return this.hydrate(this.db.all("SELECT * FROM jobs WHERE status IN ('running', 'cancelling') ORDER BY seq ASC"));
  }

  transition(id: string, to: JobStatus, details: TransitionDetails = {}): Job {
    const at = this.now().toISOString();
    this.db.transaction(() => {
      const row = this.db.get("SELECT status, pid, error FROM jobs WHERE id = ?", id);
      if (!row) throw new JobNotFoundError(id);
      const from = row.status as JobStatus;
      if (!canTransition(from, to)) throw new InvalidTransitionError(id, from, to);
      this.checkDetails(id, to, details, row.error as string | null);

      const terminal = isTerminal(to);
      const keptPid = details.pid === undefined ? ((row.pid as number | null) ?? null) : details.pid;
      this.db.run(
        `UPDATE jobs SET status = ?,
           started_at = COALESCE(started_at, ?),
           finished_at = ?,
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           outcome = COALESCE(outcome, ?),
           error = COALESCE(error, ?),
           pid = ?,
           log_path = COALESCE(?, log_path),
           report_path = COALESCE(?, report_path)
         WHERE id = ?`,
        to,
        to === "running" ? at : null,
        terminal ? at : null,
        to === "cancelling" ? at : null,
        to === "failed" ? "failure" : (details.outcome ?? null),
        details.error ?? null,
        terminal ? null : keptPid,
        details.logPath ?? null,
        details.reportPath ?? null,
        id,
      );
      if (terminal) {
        this.closePhases(id, to, at);
        // Releasing the resources in the same transaction as the final status means a job can
        // never be finished while still holding them, or the other way round.
        this.db.run("DELETE FROM locks WHERE job_id = ?", id);
      }
    });
    return this.require(id);
  }

  updatePhase(id: string, position: number, update: PhaseUpdate): Job {
    const at = this.now().toISOString();
    this.db.transaction(() => {
      const job = this.db.get("SELECT status FROM jobs WHERE id = ?", id);
      if (!job) throw new JobNotFoundError(id);
      if (!isActive(job.status as JobStatus)) throw new JobNotActiveError(id, job.status as JobStatus);

      const phase = this.db.get("SELECT status FROM job_phases WHERE job_id = ? AND position = ?", id, position);
      if (!phase) throw new RangeError(`Job ${id} has no phase at position ${position}`);
      const from = phase.status as PhaseStatus;
      if (!canPhaseTransition(from, update.status)) throw new InvalidPhaseTransitionError(id, position, from, update.status);

      this.db.run(
        `UPDATE job_phases SET status = ?,
           exit_code = COALESCE(?, exit_code), signal = COALESCE(?, signal), outcome = COALESCE(?, outcome),
           started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
           finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE job_id = ? AND position = ?`,
        update.status,
        update.exitCode ?? null,
        update.signal ?? null,
        update.outcome ?? null,
        update.status,
        at,
        FINISHED_PHASE.includes(update.status) ? 1 : 0,
        at,
        id,
        position,
      );
    });
    return this.require(id);
  }

  setPid(id: string, pid: number | null): void {
    // Only a live job may carry a pid: a stale one could make a restart kill someone else's process.
    const result = this.db.run("UPDATE jobs SET pid = ? WHERE id = ? AND status IN ('running', 'cancelling')", pid, id);
    if (result.changes > 0) return;
    const job = this.db.get("SELECT status FROM jobs WHERE id = ?", id);
    if (!job) throw new JobNotFoundError(id);
    throw new JobNotActiveError(id, job.status as JobStatus);
  }

  private assertRetryable(originalId: string): void {
    const original = this.db.get("SELECT status FROM jobs WHERE id = ?", originalId);
    if (!original) throw new RetryNotAllowedError(originalId, "missing");
    if (!isTerminal(original.status as JobStatus)) throw new RetryNotAllowedError(originalId, original.status as JobStatus);
  }

  /** The final status must be backed by the data that explains it. */
  private checkDetails(id: string, to: JobStatus, details: TransitionDetails, recordedError: string | null): void {
    const { outcome, error } = details;
    if (to === "succeeded") {
      if (outcome !== "success" && outcome !== "warning") throw new InvalidDetailsError(id, "succeeded needs outcome success or warning");
      const open = this.db.get("SELECT COUNT(*) AS n FROM job_phases WHERE job_id = ? AND status IN ('pending', 'running')", id);
      if (Number(open?.n) > 0) throw new InvalidDetailsError(id, "succeeded while a phase is still pending or running");
    } else if (to === "failed") {
      if (outcome !== undefined && outcome !== "failure") throw new InvalidDetailsError(id, "failed can only have outcome failure");
      if (!error && !recordedError) throw new InvalidDetailsError(id, "failed needs an error");
    } else if (outcome !== undefined) {
      throw new InvalidDetailsError(id, `outcome does not apply to ${to}`);
    }
  }

  /** A phase still open when the job ends did not finish normally: record how. */
  private closePhases(id: string, finalStatus: JobStatus, at: string): void {
    const cancelled = finalStatus === "cancelled";
    this.db.run("UPDATE job_phases SET status = ?, finished_at = ? WHERE job_id = ? AND status = 'running'", cancelled ? "cancelled" : "failed", at, id);
    this.db.run("UPDATE job_phases SET status = ?, finished_at = ? WHERE job_id = ? AND status = 'pending'", cancelled ? "cancelled" : "skipped", at, id);
  }

  private require(id: string): Job {
    const job = this.get(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  private hydrate(rows: readonly Row[]): Job[] {
    const phases = this.phasesOf(rows.map((row) => row.id as string));
    return rows.map((row) => toJob(row, phases.get(row.id as string) ?? []));
  }

  private phasesOf(ids: readonly string[]): Map<string, JobPhase[]> {
    const byJob = new Map<string, JobPhase[]>();
    if (ids.length === 0) return byJob;
    const rows = this.db.all(
      `SELECT * FROM job_phases WHERE job_id IN (${ids.map(() => "?").join(", ")}) ORDER BY job_id, position`,
      ...ids,
    );
    for (const row of rows) {
      const list = byJob.get(row.job_id as string) ?? [];
      list.push(toPhase(row));
      byJob.set(row.job_id as string, list);
    }
    return byJob;
  }
}
