/**
 * Branch names and the patterns of `allowedBranches`.
 *
 * A branch name is validated before it is matched or handed to git: a pattern such as
 * `feature/*` must never let `feature/..` or `--upload-pack=x` through just because `*`
 * stands for "anything".
 *
 * In patterns only `*` is special, and it never crosses a `/`: `iteration_*` matches
 * `iteration_1` but not `iteration_1/fix`. Matching is linear in the size of the inputs.
 */
export const MAX_BRANCH_LENGTH = 255;

const NAME_CHARS = /^[A-Za-z0-9._/-]+$/;
const PATTERN_CHARS = /^[A-Za-z0-9._/*-]+$/;

/** The rules git applies to each slash-separated part of a ref name. */
function isBadSegment(segment: string): boolean {
  return segment === "" || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock");
}

function isWellFormed(text: string, chars: RegExp): boolean {
  return (
    text.length > 0 &&
    text.length <= MAX_BRANCH_LENGTH &&
    chars.test(text) &&
    !text.startsWith("-") &&
    !text.split("/").some(isBadSegment)
  );
}

export function isValidBranchName(name: string): boolean {
  // git refuses a branch called HEAD, and `origin/HEAD` is a pointer to the default branch, not a branch
  return name !== "HEAD" && isWellFormed(name, NAME_CHARS);
}

export function isValidBranchPattern(pattern: string): boolean {
  return isWellFormed(pattern, PATTERN_CHARS);
}

/** Leftmost-literal glob match where `*` cannot span a `/`. */
export function branchMatches(pattern: string, branch: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === branch;

  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  const end = branch.length - last.length;
  if (!branch.startsWith(first) || end < first.length || !branch.endsWith(last)) return false;

  let position = first.length;
  for (const literal of parts.slice(1, -1)) {
    const found = branch.indexOf(literal, position);
    if (found === -1 || found + literal.length > end || branch.slice(position, found).includes("/")) return false;
    position = found + literal.length;
  }
  return !branch.slice(position, end).includes("/");
}

/** True only for a well-formed branch name that one of the patterns matches. */
export function isBranchAllowed(patterns: readonly string[], branch: string): boolean {
  return isValidBranchName(branch) && patterns.some((pattern) => branchMatches(pattern, branch));
}
