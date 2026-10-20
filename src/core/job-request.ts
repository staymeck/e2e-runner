/** The request itself is wrong (a field is missing, malformed or not allowed). */
export class InvalidJobRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobRequestError";
  }
}

/** The branch is well formed but this project does not allow it. */
export class RefNotAllowedError extends Error {
  constructor(readonly ref: string) {
    super(`Branch "${ref}" is not allowed for this project`);
    this.name = "RefNotAllowedError";
  }
}

/** The branch is allowed but does not exist in the repository (a `fetch` may bring it). */
export class RefNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`Branch "${ref}" was not found`);
    this.name = "RefNotFoundError";
  }
}

/**
 * A project's catalog could not answer: an expected condition (an old branch, missing dependencies, a
 * commit that is not a catalog at all), not a server bug. The adapter is the one that knows which of its
 * own errors mean this; it translates them here so the API never needs to know about adapter-specific error
 * types.
 */
export class CatalogReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogReadError";
  }
}

export const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Scenario and phase names as the catalog writes them; the adapter checks the exact set. */
export const TARGET_NAME = /^[A-Za-z0-9_][A-Za-z0-9._:/@-]{0,199}$/;
