import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StreamTickets } from "../src/auth/stream-ticket";

describe("StreamTickets", () => {
  it("issues a ticket that resolves to the job it was issued for", () => {
    const tickets = new StreamTickets();
    const ticket = tickets.issue("job-1");
    assert.equal(tickets.consume(ticket), "job-1");
  });

  it("is single-use: the second consume answers nothing, even immediately after", () => {
    const tickets = new StreamTickets();
    const ticket = tickets.issue("job-1");
    tickets.consume(ticket);
    assert.equal(tickets.consume(ticket), undefined);
  });

  it("answers nothing for a ticket it never issued", () => {
    const tickets = new StreamTickets();
    assert.equal(tickets.consume("not-a-real-ticket"), undefined);
  });

  it("answers nothing, and still consumes it, once the ticket has expired", async () => {
    const tickets = new StreamTickets(10);
    const ticket = tickets.issue("job-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tickets.consume(ticket), undefined);
  });

  it("gives each issued ticket its own, unpredictable value", () => {
    const tickets = new StreamTickets();
    const a = tickets.issue("job-1");
    const b = tickets.issue("job-1");
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, "a short ticket would be guessable");
  });

  it("a new issue still works correctly after an earlier ticket expired unconsumed", async () => {
    const tickets = new StreamTickets(10);
    const expired = tickets.issue("job-1"); // left unconsumed on purpose
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = tickets.issue("job-2");
    assert.equal(tickets.consume(expired), undefined);
    assert.equal(tickets.consume(fresh), "job-2");
  });
});
