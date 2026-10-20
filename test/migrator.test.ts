import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FaultyDatabase } from "./helpers/faulty-database";
import { SqliteDatabase } from "../src/db/database";
import { migrations } from "../src/db/migrations";
import { MigrationError, Migrator, type Migration } from "../src/db/migrator";
import { openDatabase } from "../src/db/open-database";
import { scratchDir } from "./helpers/workspace";

const first: Migration = { version: 1, name: "one", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" };
const second: Migration = { version: 2, name: "two", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" };

const tables = (db: SqliteDatabase) => db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);

describe("Migrator", () => {
  it("applies every migration once, in order, and records them", () => {
    const db = new SqliteDatabase(":memory:");
    assert.deepEqual(new Migrator(db, [first, second]).migrate(), [1, 2]);
    assert.ok(tables(db).includes("a") && tables(db).includes("b"));
    assert.deepEqual(db.all("SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version), [1, 2]);
  });

  it("applies only what is pending when run again", () => {
    const db = new SqliteDatabase(":memory:");
    new Migrator(db, [first]).migrate();
    assert.deepEqual(new Migrator(db, [first]).migrate(), []);
    assert.deepEqual(new Migrator(db, [first, second]).migrate(), [2]);
  });

  it("rolls a failing migration back completely and does not record it", () => {
    const db = new SqliteDatabase(":memory:");
    const broken: Migration = { version: 2, name: "broken", sql: "CREATE TABLE c (id INTEGER); THIS IS NOT SQL" };
    assert.throws(() => new Migrator(db, [first, broken]).migrate());
    assert.ok(!tables(db).includes("c"), "the half-applied migration must not leave tables behind");
    assert.deepEqual(db.all("SELECT version FROM schema_migrations").map((r) => r.version), [1]);
  });

  it("refuses to run on a database newer than the service knows", () => {
    const db = new SqliteDatabase(":memory:");
    new Migrator(db, [first, second]).migrate();
    assert.throws(() => new Migrator(db, [first]).migrate(), MigrationError);
  });

  it("refuses migrations that are not numbered 1, 2, 3...", () => {
    const db = new SqliteDatabase(":memory:");
    assert.throws(() => new Migrator(db, [second]), MigrationError);
    assert.throws(() => new Migrator(db, [first, first]), MigrationError);
  });

  it("skips a migration another process applied between the version check and the write", () => {
    const db = new SqliteDatabase(":memory:");
    new Migrator(db, [first]).migrate();
    let staleReads = 1;
    const stale = new FaultyDatabase(db, { fakeGet: (sql) => (sql.includes("MAX(version)") && staleReads-- > 0 ? { version: 0 } : undefined) });
    assert.deepEqual(new Migrator(stale, [first]).migrate(), []); // without the re-check: "table a already exists"
  });

  it("ships migrations that are numbered without gaps", () => {
    migrations.forEach((migration, index) => assert.equal(migration.version, index + 1));
  });
});

describe("openDatabase", () => {
  const root = scratchDir();

  it("creates the folder and the file, with foreign keys and the write-ahead log on", () => {
    const db = openDatabase(path.join(root, "nested", "data"));
    try {
      assert.equal(db.get("PRAGMA foreign_keys")?.foreign_keys, 1);
      assert.equal(db.get("PRAGMA journal_mode")?.journal_mode, "wal");
    } finally {
      db.close();
    }
  });

  it("makes a second writer wait, then fail with a clear busy error instead of hanging", () => {
    const file = path.join(root, "busy", "service.sqlite");
    fs.mkdirSync(path.dirname(file));
    const holder = new SqliteDatabase(file, { busyTimeoutMs: 50 });
    const waiter = new SqliteDatabase(file, { busyTimeoutMs: 50 });
    try {
      holder.exec("BEGIN IMMEDIATE");
      assert.throws(() => waiter.transaction(() => 1), /locked|busy/i);
      holder.exec("ROLLBACK");
      assert.equal(waiter.transaction(() => 1), 1, "it works again once the first writer is done");
    } finally {
      holder.close();
      waiter.close();
    }
  });

  it("keeps its content when it is closed and opened again", () => {
    const dir = path.join(root, "again");
    const db = openDatabase(dir);
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (99, 'x')");
    db.close();
    assert.throws(() => openDatabase(dir), MigrationError); // 99 is newer than this build: proves it was persisted
  });
});

describe("SqliteDatabase.transaction", () => {
  it("commits on success and rolls back on error", () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
    db.transaction(() => db.run("INSERT INTO t VALUES (1)"));
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      }),
    );
    assert.deepEqual(db.all("SELECT n FROM t").map((r) => r.n), [1]);
  });

  it("does not allow nesting", () => {
    const db = new SqliteDatabase(":memory:");
    assert.throws(() => db.transaction(() => db.transaction(() => 1)), /Nested/);
  });
});
