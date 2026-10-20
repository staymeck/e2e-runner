import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiKeyVerifier } from "../src/auth/api-key-verifier";

describe("ApiKeyVerifier", () => {
  const verifier = new ApiKeyVerifier(["current-key-0123456789", "next-key-0123456789ab"]);

  it("accepts any configured key (so a key can be rotated without downtime)", () => {
    assert.equal(verifier.verify("current-key-0123456789"), true);
    assert.equal(verifier.verify("next-key-0123456789ab"), true);
  });

  it("rejects other values, prefixes and different lengths", () => {
    for (const bad of ["wrong", "current-key-012345678", "current-key-01234567890", "", undefined]) {
      assert.equal(verifier.verify(bad), false, String(bad));
    }
  });

  it("refuses to be built without keys: there is no open mode", () => {
    assert.throws(() => new ApiKeyVerifier([]));
  });
});
