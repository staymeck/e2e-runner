import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { branchMatches, isBranchAllowed, isValidBranchName, isValidBranchPattern } from "../src/core/branch-pattern";

describe("branchMatches", () => {
  it("matches a literal name exactly", () => {
    assert.equal(branchMatches("main", "main"), true);
    assert.equal(branchMatches("main", "main2"), false);
    assert.equal(branchMatches("main", "xmain"), false);
  });

  it("lets * stand for any run of characters except a slash", () => {
    assert.equal(branchMatches("iteration_*", "iteration_1"), true);
    assert.equal(branchMatches("iteration_*", "iteration_"), true);
    assert.equal(branchMatches("iteration_*", "iteration_1/fix"), false);
    assert.equal(branchMatches("feature/*", "feature/login"), true);
    assert.equal(branchMatches("feature/*", "feature/a/b"), false);
    assert.equal(branchMatches("*", "main"), true);
    assert.equal(branchMatches("*", "a/b"), false);
  });

  it("handles stars in the middle and several stars", () => {
    assert.equal(branchMatches("release/*-rc", "release/1.2-rc"), true);
    assert.equal(branchMatches("release/*-rc", "release/1.2-rc/x"), false);
    assert.equal(branchMatches("a*b*c", "aXbYc"), true);
    assert.equal(branchMatches("a*b*c", "aXbY/c"), false);
    assert.equal(branchMatches("a*b*c", "ac"), false);
    assert.equal(branchMatches("a**b", "ab"), true);
  });

  it("does not let the prefix and suffix overlap", () => {
    assert.equal(branchMatches("ab*ba", "aba"), false);
    assert.equal(branchMatches("ab*ba", "abba"), true);
  });

  it("treats every other character literally, including regex ones", () => {
    assert.equal(branchMatches("v1.0", "v1.0"), true);
    assert.equal(branchMatches("v1.0", "v1x0"), false);
    assert.equal(branchMatches("a+b", "aab"), false);
  });

  it("stays fast on patterns that would make a regex backtrack", () => {
    const pattern = `${"*a".repeat(40)}*b`;
    const branch = "a".repeat(250);
    const started = performance.now();
    assert.equal(branchMatches(pattern, branch), false);
    assert.ok(performance.now() - started < 100);
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const name of ["main", "iteration_1", "feature/login-form", "release/v1.2.3", "fb-main-branch-e2e-runner-sta-25-secrets"]) {
      assert.equal(isValidBranchName(name), true, name);
    }
  });

  it("rejects names that are unsafe as a git argument or a path", () => {
    const bad = ["", "-x", "--upload-pack=x", "feature/..", "../x", "a/../b", "a//b", "/a", "a/", ".hidden", "a/.b", "a.", "x.lock", "a b", "a;b", "$(x)", "a\nb", "a*b", "a".repeat(256)];
    for (const name of bad) assert.equal(isValidBranchName(name), false, JSON.stringify(name));
  });
});

describe("isValidBranchPattern", () => {
  it("accepts ordinary patterns", () => {
    for (const pattern of ["main", "iteration_*", "release/v1.*", "a-b_c", "*"]) assert.equal(isValidBranchPattern(pattern), true, pattern);
  });

  it("rejects dangerous or malformed patterns", () => {
    for (const pattern of ["", "-x", "../x", "a/../b", "a//b", "/a", "a/", "a b", "a;b", "a$(x)", "a\nb", "a?b", "a[b]"]) {
      assert.equal(isValidBranchPattern(pattern), false, JSON.stringify(pattern));
    }
  });
});

describe("isBranchAllowed", () => {
  it("is true when any pattern matches a valid name", () => {
    assert.equal(isBranchAllowed(["main", "iteration_*"], "iteration_3"), true);
    assert.equal(isBranchAllowed(["main", "iteration_*"], "other"), false);
    assert.equal(isBranchAllowed([], "main"), false);
  });

  it("never lets a wildcard admit an unsafe name", () => {
    assert.equal(isBranchAllowed(["feature/*"], "feature/.."), false);
    assert.equal(isBranchAllowed(["*"], "--upload-pack=x"), false);
    assert.equal(isBranchAllowed(["*"], "a b"), false);
  });
});
