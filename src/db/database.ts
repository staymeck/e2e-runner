import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;
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

const BUSY_TIMEOUT_MS = 5000;

export class SqliteDatabase implements Database {
  private readonly db: DatabaseSync;

  /** @param file path of the database file, or ":memory:" (tests). */
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
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
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
