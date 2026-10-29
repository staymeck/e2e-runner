import type { Migration } from "../migrator";

export const webhookUrlMigration: Migration = {
  version: 2,
  name: "webhook_url",
  sql: `ALTER TABLE jobs ADD COLUMN webhook_url TEXT;`,
};
