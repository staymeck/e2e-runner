import { useEffect, useRef, useState } from "react";
import { api, apiPath, errorMessage } from "./api/client";
import type { JobView } from "./api/types";

export interface JobLogState {
  readonly job: JobView | null;
  readonly log: string;
  readonly live: boolean;
  readonly error: string | null;
  reconnect(): void;
}

/**
 * Mirrors STA-31's real protocol: a one-time ticket from `POST .../stream-ticket`, then
 * `GET /v1/jobs/:id/stream?ticket=...&from=<byte offset>` — plain text chunks, not a JSON envelope,
 * closing with code 1000 once the job finishes. No automatic reconnect on an abnormal close yet: a
 * dropped connection (not the job finishing) just stops the live tail, with `reconnect()` to resume it.
 *
 * Shared by `JobLogPage` (one job, picked by the URL) and `ScenarioDetailPage` (whichever job is the
 * scenario's own most recent one, which can change between polls) — both just need "watch this job id's
 * log live," so the connect/reconnect/generation-guard logic lives here once.
 */
export function useJobLog(jobId: string | undefined): JobLogState {
  const [job, setJob] = useState<JobView | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  // Bumped by the effect's cleanup, so a `connect()` left over from a fast remount or a fast
  // job-to-job switch (its awaits still pending) never applies its result once superseded — found by
  // review on JobLogPage: without this, two overlapping connects could leak a socket and cross the log
  // of one job into the view now showing a different one.
  const generationRef = useRef(0);

  const refreshJob = (id: string) => {
    api.jobs
      .get(id)
      .then(setJob)
      .catch((err) => setError(errorMessage(err)));
  };

  const connect = async (id: string) => {
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    try {
      const initial = await api.jobs.log(id, 0);
      if (!isCurrent()) return;
      setLog(initial.text);

      const { ticket } = await api.jobs.streamTicket(id);
      if (!isCurrent()) return;

      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${location.host}${apiPath(`/v1/jobs/${encodeURIComponent(id)}/stream`)}?ticket=${ticket}&from=${initial.nextFrom}`);
      if (!isCurrent()) {
        socket.close();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        if (isCurrent()) setLive(true);
      };
      socket.onmessage = (event) => {
        if (isCurrent()) setLog((current) => current + String(event.data));
      };
      socket.onclose = () => {
        if (!isCurrent()) return;
        setLive(false);
        socketRef.current = null;
        refreshJob(id); // the job may just have finished (the usual reason this closes) — stop showing it as running
      };
      socket.onerror = () => {
        if (isCurrent()) setError("La conexión en vivo se interrumpió");
      };
    } catch (err) {
      if (isCurrent()) setError(errorMessage(err));
    }
  };

  useEffect(() => {
    setJob(null);
    setLog("");
    setError(null);
    setLive(false);
    if (!jobId) return;
    refreshJob(jobId);
    connect(jobId);
    return () => {
      generationRef.current++;
      socketRef.current?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return { job, log, live, error, reconnect: () => jobId && connect(jobId) };
}
