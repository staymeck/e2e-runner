import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

/**
 * The small slice of SQLite the service uses. Everything else depends on this interface,
 * so `node:sqlite` (experimental in Node 22) could be swapped for another driver in one place.
 */
export interface Database {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(sql: string, ...params: SqlValue[]): Row | undefined;
  all(sql: string, ...params: SqlValue[]): Row[];
  /** Runs `work` inside BEGIN IMMEDIATE ... COMMIT; rolls back and rethrows if it throws. Not reentrant. */
  transaction<T>(work: () => T): T;
  close(): void;
}

export interface SqliteOptions {
  /** How long a writer waits for another one before failing with SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export class SqliteDatabase implements Database {
  private readonly db: DatabaseSync;

  /** @param file path of the database file, or ":memory:" (tests). */
  constructor(file: string, options: SqliteOptions = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (file !== ":memory:") this.enableWriteAheadLog(file);
  }

  /** Readers must not block the runner's writes, which is what WAL gives; refuse to run without it. */
  private enableWriteAheadLog(file: string): void {
    const mode = this.db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode?.toLowerCase() !== "wal") {
      this.db.close();
      throw new Error(`The filesystem of ${file} does not support SQLite WAL mode (got "${mode?.journal_mode}"); use a local disk for E2E_SERVICE_DATA_DIR`);
    }
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) throw new Error("Nested transactions are not supported");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        // SQLite may already have rolled back (e.g. disk full): never let that hide the real error
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
