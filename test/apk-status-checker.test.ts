import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApkStatusReadError, parseApkStatus, SUPPORTED_APK_STATUS_CONTRACT_VERSIONS } from "../src/adapters/detox/apk-status-checker";

/**
 * Guards the exact regression that reached production: the orchestrator bumped apk-status to
 * contract v2 (adding `status` from its new apk-catalog), and this client only accepted v1 —
 * every apk-status check started throwing ApkStatusReadError, wrapped into CatalogReadError by
 * detox-adapter.ts, surfacing as a 422 on GET .../targets/:scenario/apk-status.
 */
describe("parseApkStatus", () => {
  it("accepts a v1 payload with no status field at all", () => {
    const status = parseApkStatus({
      contractVersion: 1,
      scenarioId: "login",
      kind: "step",
      apps: [{ app: "kpmake", branch: "main", ready: true }],
    });
    assert.deepEqual(status.apps[0], { app: "kpmake", branch: "main", ready: true });
  });

  it("accepts a v2 payload and carries the apk-catalog status through", () => {
    const status = parseApkStatus({
      contractVersion: 2,
      scenarioId: "login",
      kind: "step",
      apps: [{ app: "kpmake", branch: "main", ready: true, status: "compiled" }],
    });
    assert.deepEqual(status.apps[0], { app: "kpmake", branch: "main", ready: true, status: "compiled" });
  });

  it("SUPPORTED_APK_STATUS_CONTRACT_VERSIONS lists exactly 1 and 2 — bump this test, not just the orchestrator, for v3", () => {
    assert.deepEqual(SUPPORTED_APK_STATUS_CONTRACT_VERSIONS, [1, 2]);
  });

  it("rejects a contract version this client does not know yet", () => {
    assert.throws(
      () => parseApkStatus({ contractVersion: 3, scenarioId: "login", kind: "step", apps: [] }),
      ApkStatusReadError,
    );
  });

  it("rejects a status value outside the four known ones, instead of passing it through blindly", () => {
    assert.throws(
      () =>
        parseApkStatus({
          contractVersion: 2,
          scenarioId: "login",
          kind: "step",
          apps: [{ app: "kpmake", branch: "main", ready: true, status: "building_but_misspelled" }],
        }),
      ApkStatusReadError,
    );
  });

  it("rejects a null/missing document the same way an unknown version would", () => {
    assert.throws(() => parseApkStatus(null), ApkStatusReadError);
    assert.throws(() => parseApkStatus(undefined), ApkStatusReadError);
  });
});
