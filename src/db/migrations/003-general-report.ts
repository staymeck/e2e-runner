import type { Migration } from "../migrator";

export const generalReportMigration: Migration = {
  version: 3,
  name: "general_report",
  sql: `
    ALTER TABLE jobs ADD COLUMN report_scope TEXT NOT NULL DEFAULT 'general';

    CREATE TABLE general_report_entries (
      project TEXT NOT NULL,
      branch TEXT NOT NULL,
      target TEXT NOT NULL,
      latest_job_id TEXT NOT NULL REFERENCES jobs(id),
      latest_outcome TEXT NOT NULL CHECK (latest_outcome IN ('success','warning','failure')),
      latest_finished_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project, branch, target)
    );
    CREATE INDEX general_report_by_branch ON general_report_entries (project, branch);
  `,
};
