/**
 * Branch name patterns used by `allowedBranches`.
 *
 * Only `*` is special and it never crosses a `/`: `iteration_*` matches `iteration_1`
 * but not `iteration_1/fix`. Anything else is matched literally.
 */
const SPECIAL_REGEX_CHARS = /[.+?^${}()|[\]\\]/g;

export const BRANCH_PATTERN_SYNTAX = /^[A-Za-z0-9._/*-]+$/;

export function isValidBranchPattern(pattern: string): boolean {
  return (
    BRANCH_PATTERN_SYNTAX.test(pattern) &&
    !pattern.startsWith("-") &&
    !pattern.split("/").some((part) => part === ".." || part === "")
  );
}

export function branchMatches(pattern: string, branch: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(SPECIAL_REGEX_CHARS, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(branch);
}

export function isBranchAllowed(patterns: readonly string[], branch: string): boolean {
  return patterns.some((pattern) => branchMatches(pattern, branch));
}
