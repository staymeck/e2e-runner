import type { Database, Row, SqlValue } from "../../src/db/database";

export const PASS = Symbol("PASS");

export interface Faults {
  /** Return true to make this `run` throw instead of executing. `count` is how many runs came before. */
  readonly failRun?: (sql: string, count: number) => boolean;
  /** Return a row to answer a `get` with instead of asking the database (a stale read). */
  readonly fakeGet?: (sql: string, count: number) => Row | undefined | typeof PASS;
}

/** A database that misbehaves on demand, to prove that writes are atomic and races are handled. */
export class FaultyDatabase implements Database {
  private runs = 0;
  private gets = 0;

  constructor(
    private readonly inner: Database,
    private readonly faults: Faults,
  ) {}

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    if (this.faults.failRun?.(sql, this.runs++)) throw new Error("injected failure");
    return this.inner.run(sql, ...params);
  }

  get(sql: string, ...params: SqlValue[]): Row | undefined {
    const fake = this.faults.fakeGet?.(sql, this.gets++) ?? PASS;
    return fake === PASS ? this.inner.get(sql, ...params) : fake;
  }

  all(sql: string, ...params: SqlValue[]): Row[] {
    return this.inner.all(sql, ...params);
  }

  transaction<T>(work: () => T): T {
    return this.inner.transaction(work);
  }

  close(): void {
    this.inner.close();
  }
}
