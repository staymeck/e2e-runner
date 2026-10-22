import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSessions } from "../src/auth/web-sessions";

const mobile = { username: "ana", role: "e2e-mobile" as const };

describe("WebSessions", () => {
  it("issues a session that resolves to the user it was issued for", () => {
    const sessions = new WebSessions();
    const token = sessions.issue(mobile);
    assert.deepEqual(sessions.verify(token), mobile);
  });

  it("is read many times, unlike a one-time ticket: verifying twice still answers", () => {
    const sessions = new WebSessions();
    const token = sessions.issue(mobile);
    sessions.verify(token);
    assert.deepEqual(sessions.verify(token), mobile);
  });

  it("answers nothing for a token it never issued, or none at all", () => {
    const sessions = new WebSessions();
    assert.equal(sessions.verify("not-a-real-token"), undefined);
    assert.equal(sessions.verify(undefined), undefined);
  });

  it("answers nothing once the session has expired", async () => {
    const sessions = new WebSessions(10);
    const token = sessions.issue(mobile);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sessions.verify(token), undefined);
  });

  it("gives each issued session its own, unpredictable token", () => {
    const sessions = new WebSessions();
    const a = sessions.issue(mobile);
    const b = sessions.issue(mobile);
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, "a short token would be guessable");
  });

  it("revoke makes the token stop working right away, and is a safe no-op for one that was never issued", () => {
    const sessions = new WebSessions();
    const token = sessions.issue(mobile);
    sessions.revoke(token);
    assert.equal(sessions.verify(token), undefined);
    assert.doesNotThrow(() => sessions.revoke("never-issued"));
    assert.doesNotThrow(() => sessions.revoke(undefined));
  });

  it("caps live sessions per username: logging in past the limit drops that user's oldest session first", () => {
    const sessions = new WebSessions(undefined, 3);
    const tokens = [sessions.issue(mobile), sessions.issue(mobile), sessions.issue(mobile)];
    const latest = sessions.issue(mobile); // a 4th, past the cap of 3

    assert.equal(sessions.verify(tokens[0]), undefined, "the oldest session should have been evicted");
    assert.deepEqual(sessions.verify(tokens[1]), mobile);
    assert.deepEqual(sessions.verify(tokens[2]), mobile);
    assert.deepEqual(sessions.verify(latest), mobile);
  });

  it("the per-username cap does not evict another user's sessions", () => {
    const sessions = new WebSessions(undefined, 1);
    const admin = { username: "root", role: "admin" as const };
    const ana = sessions.issue(mobile);
    const root = sessions.issue(admin);
    sessions.issue(mobile); // pushes ana past her own cap of 1

    assert.equal(sessions.verify(ana), undefined);
    assert.deepEqual(sessions.verify(root), admin, "root's session must survive ana logging in again");
  });
});
