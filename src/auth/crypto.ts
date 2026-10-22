import { createHash } from "node:crypto";

/** Shared by every constant-time secret comparison in `src/auth/` (API keys, web user passwords). */
export function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
