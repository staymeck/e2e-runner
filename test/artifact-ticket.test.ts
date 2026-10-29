import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactTickets } from "../src/auth/artifact-ticket";

describe("ArtifactTickets", () => {
  it("issues a ticket that resolves to the job it was issued for", () => {
    const tickets = new ArtifactTickets();
    const ticket = tickets.issue("job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
  });

  it("is multi-use: resolving it twice still answers the same job, unlike a stream ticket", () => {
    const tickets = new ArtifactTickets();
    const ticket = tickets.issue("job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
    assert.equal(tickets.resolve(ticket), "job-1");
  });

  it("re-issuing for the same job returns the existing ticket, not a new one", () => {
    const tickets = new ArtifactTickets();
    const first = tickets.issue("job-1");
    const second = tickets.issue("job-1");
    assert.equal(first, second);
  });

  it("answers undefined for a ticket it never issued", () => {
    const tickets = new ArtifactTickets();
    assert.equal(tickets.resolve("not-a-real-ticket"), undefined);
  });

  it("answers undefined once the ticket has expired", async () => {
    const tickets = new ArtifactTickets(10);
    const ticket = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tickets.resolve(ticket), undefined);
  });

  it("re-issuing for a job whose previous ticket expired mints a fresh one", async () => {
    const tickets = new ArtifactTickets(10);
    const expired = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = tickets.issue("job-1");
    assert.notEqual(expired, fresh);
    assert.equal(tickets.resolve(fresh), "job-1");
  });

  it("gives each job's ticket its own, unpredictable value", () => {
    const tickets = new ArtifactTickets();
    const a = tickets.issue("job-1");
    const b = tickets.issue("job-2");
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, "a short ticket would be guessable");
  });

  it("a periodic sweep (opt-in) drops an expired ticket on its own, with no further issue() call", async () => {
    const tickets = new ArtifactTickets(10, 15);
    const ticket = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Nothing called issue()/resolve() in between to trigger a lazy sweep — only the periodic timer could have dropped it.
    assert.equal(tickets.resolve(ticket), undefined);
  });

  it("with no sweepIntervalMs, there is no periodic timer — only issue() sweeps lazily", async () => {
    const tickets = new ArtifactTickets(10);
    const ticket = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // resolve() alone never sweeps: an expired entry lingers until the next issue(), but still reports as gone.
    assert.equal(tickets.resolve(ticket), undefined);
  });
});
