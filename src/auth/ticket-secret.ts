import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SECRET_FILE = "artifact-ticket-secret";

/**
 * The HMAC secret `SignedArtifactTickets` signs with, generated once per install and kept in
 * `dataDir` — the same durable folder as the database/logs/reports — so it reads back the same value
 * across every restart without needing a new required environment variable just for this. Never
 * logged, never returned to a caller other than the signer itself.
 */
export function loadOrCreateTicketSecret(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // no readable secret yet: generate one below
  }
  const secret = randomBytes(32).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
