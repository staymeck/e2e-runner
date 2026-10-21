import * as fs from "node:fs";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

function debugLog(message: string): void {
  fs.appendFileSync("/tmp/debug-close.log", `${Date.now()} ${message}\n`);
}
import type { StreamTickets } from "../auth/stream-ticket";
import { isTerminal } from "../core/job";
import type { JobLogReader } from "../core/job-log";
import type { JobService } from "../core/job-service";

const STREAM_PATH = /^\/v1\/jobs\/([^/]+)\/stream$/;
const POLL_MS = 300;
/** How often an idle connection is pinged, and (at twice this) how long a client may go without a pong. */
const PING_MS = 30_000;

export interface LogStreamDeps {
  readonly jobs: JobService;
  readonly logs: JobLogReader;
  readonly tickets: StreamTickets;
  readonly pollMs?: number;
  readonly pingMs?: number;
}

/**
 * Attaches the log-tailing WebSocket directly to the HTTP server, outside of Nest's own request
 * pipeline: a browser's WebSocket handshake cannot carry an `Authorization` header, so this path is
 * guarded by a one-time ticket in the query string instead of `ApiKeyGuard`. Returns a function that
 * detaches it and closes every open connection, for a clean shutdown.
 */
export function attachLogStream(server: HttpServer, deps: LogStreamDeps): () => void {
  const pollMs = deps.pollMs ?? POLL_MS;
  const pingMs = deps.pingMs ?? PING_MS;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(request.url ?? "", "http://stream.internal");
    const match = STREAM_PATH.exec(url.pathname);
    if (!match) return; // not this server's route: leave the socket for anyone else listening

    const jobId = decodeURIComponent(match[1]!);
    const resolved = deps.tickets.consume(url.searchParams.get("ticket") ?? "");
    if (resolved === undefined || resolved !== jobId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const fromParam = url.searchParams.get("from");
    const from = fromParam !== null && /^\d+$/.test(fromParam) ? Number(fromParam) : 0;
    wss.handleUpgrade(request, socket, head, (ws) => tail(ws, jobId, from));
  };
  server.on("upgrade", onUpgrade);

  function tail(ws: WebSocket, jobId: string, from: number): void {
    sockets.add(ws);
    let position = from;
    let stopped = false;
    let alive = true;

    const stop = (): void => {
      stopped = true;
      clearInterval(pinger);
      sockets.delete(ws);
    };
    // A malformed frame from the client makes `ws` emit 'error'; with no listener, Node treats that as
    // an uncaught exception and kills the whole process (every other job's stream included). One bad
    // client must only lose its own connection.
    ws.on("error", stop);
    ws.on("close", stop);

    // A client that vanishes without a TCP close (network drop, laptop sleep) would otherwise stay
    // "open" and polling until the job itself finishes, however long that takes.
    ws.on("pong", () => (alive = true));
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, pingMs);
    pinger.unref();

    const pump = (): void => {
      if (stopped) return;
      const chunk = deps.logs.read(jobId, position);
      if (chunk.text) {
        position = chunk.nextFrom;
        ws.send(chunk.text);
      }
      let job;
      try {
        job = deps.jobs.get(jobId);
      } catch {
        ws.close(1011, "job no longer exists");
        return;
      }
      if (isTerminal(job.status)) {
        ws.close(1000, "job finished");
        return;
      }
      setTimeout(pump, pollMs).unref();
    };
    pump();
  }

  return () => {
    debugLog(`detach(): ${sockets.size} sockets tracked`);
    server.off("upgrade", onUpgrade);
    for (const ws of sockets) {
      debugLog(`detach(): closing a socket, readyState=${ws.readyState}`);
      ws.close(1001, "server shutting down");
    }
    wss.close();
    debugLog("detach(): wss.close() returned");
  };
}
