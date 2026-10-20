import type { Migration } from "../migrator";

export const initialMigration: Migration = {
  version: 1,
  name: "initial",
  sql: `
    CREATE TABLE jobs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','cancelling','succeeded','failed','cancelled')),
      ref TEXT NOT NULL,
      sha TEXT NOT NULL,
      target TEXT NOT NULL,
      params TEXT NOT NULL,
      locks TEXT NOT NULL,
      retry_of TEXT REFERENCES jobs(id),
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      cancel_requested_at TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','warning','failure')),
      error TEXT,
      pid INTEGER,
      log_path TEXT,
      report_path TEXT
    );
    CREATE INDEX jobs_by_ref ON jobs (project, ref, seq);
    CREATE INDEX jobs_by_target ON jobs (project, target, seq);
    CREATE INDEX jobs_by_status ON jobs (status, seq);
    CREATE INDEX jobs_by_retry ON jobs (retry_of);

    CREATE TABLE job_phases (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled')),
      exit_code INTEGER,
      signal TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','warning','failure')),
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (job_id, position)
    );

    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id)
    );
  `,
};
