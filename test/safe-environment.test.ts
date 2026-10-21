import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childEnvironment } from "../src/infra/safe-environment";

describe("childEnvironment", () => {
  it("removes the service's API keys and keeps everything else", () => {
    const result = childEnvironment({
      PATH: "/usr/bin",
      E2E_SERVICE_API_KEY: "current-key-0123456789",
      E2E_SERVICE_API_KEY_NEXT: "next-key-0123456789",
      SOME_OTHER_VAR: "kept",
    });
    assert.deepEqual(result, { PATH: "/usr/bin", SOME_OTHER_VAR: "kept" });
  });

  it("drops variables that are present but undefined", () => {
    const result = childEnvironment({ PATH: "/usr/bin", GHOST: undefined });
    assert.deepEqual(result, { PATH: "/usr/bin" });
  });

  it("defaults to the service's own process.env", () => {
    process.env.E2E_TEST_CHILD_ENV_MARKER = "visible";
    try {
      assert.equal(childEnvironment().E2E_TEST_CHILD_ENV_MARKER, "visible");
    } finally {
      delete process.env.E2E_TEST_CHILD_ENV_MARKER;
    }
  });
});
