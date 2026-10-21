import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { attachLogStream } from "../src/api/log-stream-server";
import { StreamTickets } from "../src/auth/stream-ticket";
import { JobNotFoundError, type Job, type JobStatus } from "../src/core/job";
import type { JobLogReader, LogChunk } from "../src/core/job-log";
import type { JobService } from "../src/core/job-service";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
    await sleep(10);
  }
}

/** Guards any wait on a real socket event: a regression that stops it from firing must fail the test, not hang it. */
async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let settled = false;
  const guarded = promise.finally(() => (settled = true));
  const timeout = sleep(timeoutMs).then((): T => {
    if (!settled) throw new Error(`timed out waiting for: ${label}`);
    return undefined as T;
  });
  return Promise.race([guarded, timeout]);
}

/** A rejected handshake must fail the test, not hang it forever, if a regression ever lets it connect instead. */
function expectRejection(ws: WebSocket, timeoutMs = 5000): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the handshake to be rejected")), timeoutMs);
    ws.once("error", (error) => {
      clearTimeout(timer);
      resolve(error);
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("the handshake was accepted instead of rejected"));
    });
  });
}

/** The log of one job, as a plain growable string: simplest real stand-in for FileJobLog's byte offsets. */
class FakeLog implements JobLogReader {
  private text = "";
  append(chunk: string): void {
    this.text += chunk;
  }
  read(_jobId: string, from = 0): LogChunk {
    const start = Math.max(0, Math.min(from, this.text.length));
    return { text: this.text.slice(start), nextFrom: this.text.length };
  }
}

class FakeJobs {
  status: JobStatus = "running";
  get(id: string): Job {
    if (id !== "job-1") throw new JobNotFoundError(id);
    return { status: this.status } as Job; // only .status is ever read by attachLogStream
  }
}

const liveServers: http.Server[] = [];
after(() => {
  for (const server of liveServers) server.close();
});

async function listen(server: http.Server): Promise<number> {
  liveServers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function rig(pollMs = 20, pingMs = 30_000) {
  const logs = new FakeLog();
  const jobs = new FakeJobs();
  const tickets = new StreamTickets();
  const server = http.createServer((_req, res) => res.end());
  const detach = attachLogStream(server, { jobs: jobs as unknown as JobService, logs, tickets, pollMs, pingMs });
  return { logs, jobs, tickets, server, detach };
}

/**
 * A raw TCP client that completes the WS handshake itself and writes frames by hand: unlike the real
 * `ws` client, it never masks a frame (RFC 6455 requires a client to mask; a server must reject an
 * unmasked one) and never auto-responds to a ping with a pong. Exactly what is needed to reproduce the
 * two issues the review found that a well-behaved client, by construction, cannot trigger.
 */
async function rawConnect(port: number, path: string): Promise<net.Socket> {
  const socket = net.createConnection({ port, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("latin1").includes(" 101 ")) {
        socket.off("data", onData);
        resolve();
      }
    };
    socket.once("error", reject);
    socket.on("data", onData);
  });
  return socket;
}

/** An unmasked text frame: well-formed WS framing, but violates the one rule a client must follow. */
function unmaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/**
 * The message listener is attached before `open` is awaited, not after: the server can send its first
 * chunk so fast that it arrives in the same synchronous pass as the handshake, which would emit
 * 'message' before a listener attached only after `open` resolves (a microtask later) ever existed.
 */
async function connected(url: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const ws = new WebSocket(url);
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(data.toString()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}

describe("attachLogStream", () => {
  it("replays what was already logged, then streams new content live", async () => {
    const { logs, tickets, server, detach } = rig();
    logs.append("hello ");
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      const { ws, messages } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}`);

      await waitFor(() => messages.join("") === "hello ", "the replayed text");
      logs.append("world");
      await waitFor(() => messages.join("") === "hello world", "the live update");
      ws.close();
    } finally {
      detach();
    }
  });

  it("replays from the byte offset given in the query string, not from the start", async () => {
    const { logs, tickets, server, detach } = rig();
    logs.append("0123456789");
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      const { ws, messages } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}&from=5`);
      await waitFor(() => messages.join("") === "56789", "only the bytes from offset 5 onward");
      ws.close();
    } finally {
      detach();
    }
  });

  it("closes the connection (code 1000) once the job reaches a terminal status", async () => {
    const { jobs, tickets, server, detach } = rig();
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      const { ws } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}`);
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      jobs.status = "succeeded";
      assert.equal(await withTimeout(closed, "the socket to close once the job finished"), 1000);
    } finally {
      detach();
    }
  });

  it("rejects the handshake, closing the raw socket, for a ticket that was never issued", async () => {
    const { server, detach } = rig();
    try {
      const port = await listen(server);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=not-a-real-ticket`);
      const failure = await expectRejection(ws);
      assert.match(failure.message, /401|Unexpected server response/);
    } finally {
      detach();
    }
  });

  it("a ticket works only once: a second connection with the same ticket is rejected", async () => {
    const { tickets, server, detach } = rig();
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      const { ws: first } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}`);
      first.close();

      const second = new WebSocket(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}`);
      const failure = await expectRejection(second);
      assert.match(failure.message, /401|Unexpected server response/);
    } finally {
      detach();
    }
  });

  it("rejects a ticket issued for a different job than the one in the path", async () => {
    const { tickets, server, detach } = rig();
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/jobs/job-2/stream?ticket=${ticket}`);
      const failure = await expectRejection(ws);
      assert.match(failure.message, /401|Unexpected server response/);
    } finally {
      detach();
    }
  });

  it("detach() closes every open connection and stops answering new handshakes", async () => {
    const { tickets, server, detach } = rig();
    const port = await listen(server);
    const ticket = tickets.issue("job-1");
    const { ws } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${ticket}`);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    detach();
    assert.equal(await withTimeout(closed, "the socket to close on detach"), 1001);
  });

  it("a malformed frame from one client drops only that connection, never the process", async () => {
    const { logs, tickets, server, detach } = rig();
    try {
      const port = await listen(server);

      // A second, well-behaved client, kept alive across the bad frame below: if it can still receive
      // a live update afterward, the server (and the process running this very test) is still up.
      // Before the fix, the bad frame made `ws` emit an unhandled 'error', which Node treats as an
      // uncaught exception and would have taken this whole test process down with it.
      const goodTicket = tickets.issue("job-1");
      const { ws: good, messages } = await connected(`ws://127.0.0.1:${port}/v1/jobs/job-1/stream?ticket=${goodTicket}`);

      const badTicket = tickets.issue("job-1");
      const bad = await rawConnect(port, `/v1/jobs/job-1/stream?ticket=${badTicket}`);
      bad.write(unmaskedTextFrame("hello"));
      await waitFor(() => bad.destroyed, "the bad connection to be dropped by the server");

      logs.append("still alive");
      await waitFor(() => messages.join("") === "still alive", "the good connection to keep working");
      good.close();
    } finally {
      detach();
    }
  });

  it("terminates a connection that stops answering pings, instead of polling it forever", async () => {
    const { tickets, server, detach } = rig(20, 30); // a 30ms ping interval; no real client would ever go unanswered that fast
    try {
      const port = await listen(server);
      const ticket = tickets.issue("job-1");
      // A raw client that completes the handshake and then goes silent: it never answers a ping with a
      // pong, which a real `ws` client always does automatically (so this could not be reproduced with one).
      const zombie = await rawConnect(port, `/v1/jobs/job-1/stream?ticket=${ticket}`);
      await waitFor(() => zombie.destroyed, "the unresponsive connection to be terminated after a missed pong", 2000);
    } finally {
      detach();
    }
  });
});
