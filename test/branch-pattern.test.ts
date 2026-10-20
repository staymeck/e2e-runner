import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { branchMatches, isBranchAllowed, isValidBranchPattern } from "../src/core/branch-pattern";

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
  });

  it("treats every other character literally, including regex ones", () => {
    assert.equal(branchMatches("v1.0", "v1.0"), true);
    assert.equal(branchMatches("v1.0", "v1x0"), false);
    assert.equal(branchMatches("a+b", "aab"), false);
  });
});

describe("isBranchAllowed", () => {
  it("is true when any pattern matches", () => {
    assert.equal(isBranchAllowed(["main", "iteration_*"], "iteration_3"), true);
    assert.equal(isBranchAllowed(["main", "iteration_*"], "other"), false);
    assert.equal(isBranchAllowed([], "main"), false);
  });
});

describe("isValidBranchPattern", () => {
  it("accepts ordinary patterns", () => {
    for (const pattern of ["main", "iteration_*", "release/v1.*", "a-b_c"]) assert.equal(isValidBranchPattern(pattern), true, pattern);
  });

  it("rejects dangerous or malformed patterns", () => {
    for (const pattern of ["", "-x", "../x", "a/../b", "a//b", "/a", "a/", "a b", "a;b", "a$(x)", "a\nb"]) {
      assert.equal(isValidBranchPattern(pattern), false, JSON.stringify(pattern));
    }
  });
});
