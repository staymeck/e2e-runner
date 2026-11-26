import type { Migration } from "../migrator";
import { initialMigration } from "./001-initial";
import { webhookUrlMigration } from "./002-webhook-url";
import { generalReportMigration } from "./003-general-report";

/** Append new migrations at the end; never edit one that has shipped. */
export const migrations: readonly Migration[] = [initialMigration, webhookUrlMigration, generalReportMigration];
