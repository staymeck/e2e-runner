import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WebUserCredential } from "../src/config/service-config";
import { WebUserDirectory } from "../src/auth/web-users";

const USERS: readonly WebUserCredential[] = [
  { username: "ana", password: "ana-password-123", role: "e2e-mobile" },
  { username: "root", password: "root-password-456", role: "admin" },
];

describe("WebUserDirectory", () => {
  it("resolves a correct username and password to that user's role", () => {
    const directory = new WebUserDirectory(USERS);
    assert.deepEqual(directory.verify("ana", "ana-password-123"), { username: "ana", role: "e2e-mobile" });
  });

  it("rejects a wrong password, an unknown username, and a missing username or password", () => {
    const directory = new WebUserDirectory(USERS);
    assert.equal(directory.verify("ana", "wrong"), undefined);
    assert.equal(directory.verify("ghost", "ana-password-123"), undefined);
    assert.equal(directory.verify(undefined, "ana-password-123"), undefined);
    assert.equal(directory.verify("ana", undefined), undefined);
  });

  it("never matches one user's password against another's username", () => {
    const directory = new WebUserDirectory(USERS);
    assert.equal(directory.verify("ana", "root-password-456"), undefined);
  });

  it("answers nothing for an empty directory", () => {
    assert.equal(new WebUserDirectory([]).verify("ana", "anything"), undefined);
  });
});
