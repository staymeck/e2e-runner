import type { Migration } from "../migrator";
import { initialMigration } from "./001-initial";

/** Append new migrations at the end; never edit one that has shipped. */
export const migrations: readonly Migration[] = [initialMigration];
