import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase, type Database } from "./database";
import { migrations } from "./migrations";
import { Migrator } from "./migrator";

export const DATABASE_FILE = "service.sqlite";

/** Opens the service database in `dataDir` (created if missing) and brings its schema up to date. */
export function openDatabase(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  return migrated(new SqliteDatabase(path.join(dataDir, DATABASE_FILE)));
}

/** An in-memory database with the schema applied. Tests only; it disappears when closed. */
export function openMemoryDatabase(): Database {
  return migrated(new SqliteDatabase(":memory:"));
}

function migrated(db: Database): Database {
  try {
    new Migrator(db, migrations).migrate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
