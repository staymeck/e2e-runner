import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignedArtifactTickets } from "../src/auth/signed-artifact-tickets";

const SECRET = "test-secret-0123456789";

describe("SignedArtifactTickets", () => {
  it("issues a ticket that resolves to the subject it was issued for", () => {
    const tickets = new SignedArtifactTickets(SECRET);
    const ticket = tickets.issue("job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
  });

  it("is multi-use: resolving it twice still answers the same subject", () => {
    const tickets = new SignedArtifactTickets(SECRET);
    const ticket = tickets.issue("job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
  });

  it("stays valid across separate instances sharing the same secret — a restart with no in-memory state", () => {
    const first = new SignedArtifactTickets(SECRET);
    const ticket = first.issue("job-1");
    const afterRestart = new SignedArtifactTickets(SECRET);
    assert.equal(afterRestart.resolve(ticket), "job-1");
  });

  it("rejects a ticket signed with a different secret", () => {
    const issuer = new SignedArtifactTickets(SECRET);
    const ticket = issuer.issue("job-1");
    const verifier = new SignedArtifactTickets("a-different-secret");
    assert.equal(verifier.resolve(ticket), undefined);
  });

  it("rejects a tampered payload even if the signature format still looks right", () => {
    const tickets = new SignedArtifactTickets(SECRET);
    const ticket = tickets.issue("job-1");
    const dot = ticket.lastIndexOf(".");
    const tampered = `${ticket.slice(0, dot)}x${ticket.slice(dot)}`;
    assert.equal(tickets.resolve(tampered), undefined);
  });

  it("answers undefined for garbage input", () => {
    const tickets = new SignedArtifactTickets(SECRET);
    assert.equal(tickets.resolve("not-a-real-ticket"), undefined);
    assert.equal(tickets.resolve(""), undefined);
  });

  it("answers undefined once the ticket has expired", async () => {
    const tickets = new SignedArtifactTickets(SECRET, 10);
    const ticket = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tickets.resolve(ticket), undefined);
  });

  it("gives each subject's ticket its own, unpredictable value", () => {
    const tickets = new SignedArtifactTickets(SECRET);
    const a = tickets.issue("job-1");
    const b = tickets.issue("job-2");
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, "a short ticket would be guessable");
  });
});
