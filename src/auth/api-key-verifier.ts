import { createHash, timingSafeEqual } from "node:crypto";

export const API_KEY_VERIFIER = Symbol("API_KEY_VERIFIER");

/** Decides whether a presented credential is one of the accepted API keys. */
export interface CredentialVerifier {
  verify(presented: string | undefined): boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Compares SHA-256 digests in constant time, against every accepted key without
 * stopping at the first match, so neither the length of a key nor which key matched
 * leaks through timing.
 */
export class ApiKeyVerifier implements CredentialVerifier {
  private readonly digests: readonly Buffer[];

  constructor(keys: readonly string[]) {
    if (keys.length === 0) throw new Error("ApiKeyVerifier needs at least one key");
    this.digests = keys.map(digest);
  }

  verify(presented: string | undefined): boolean {
    if (!presented) return false;
    const candidate = digest(presented);
    let matched = false;
    for (const accepted of this.digests) {
      if (timingSafeEqual(candidate, accepted)) matched = true;
    }
    return matched;
  }
}
