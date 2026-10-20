import type { Database } from "./database";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class MigrationError extends Error {}

/**
 * Applies pending migrations in order, each in its own transaction, and records them.
 * Migrations are plain data (not files) so `tsc` ships them with no copy step.
 */
export class Migrator {
  constructor(
    private readonly db: Database,
    private readonly migrations: readonly Migration[],
    private readonly now: () => Date = () => new Date(),
  ) {
    migrations.forEach((migration, index) => {
      if (migration.version !== index + 1) {
        throw new MigrationError(`Migrations must be numbered 1, 2, 3... without gaps (found ${migration.version} at position ${index + 1})`);
      }
    });
  }

  /** Brings the schema to the latest version and returns the versions it applied. */
  migrate(): number[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const current = Number(this.db.get("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")?.version ?? 0);
    if (current > this.migrations.length) {
      throw new MigrationError(
        `The database is at schema version ${current} but this build only knows ${this.migrations.length}: refusing to run an older service on a newer database`,
      );
    }
    const applied: number[] = [];
    for (const migration of this.migrations.slice(current)) {
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, this.now().toISOString());
      });
      applied.push(migration.version);
    }
    return applied;
  }
}
