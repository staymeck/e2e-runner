import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import type { JobView } from "../../api/types";
import { StatusBadge } from "../../components/StatusBadge";

/**
 * Mirrors STA-31's real protocol: a one-time ticket from `POST .../stream-ticket`, then
 * `GET /v1/jobs/:id/stream?ticket=...&from=<byte offset>` — plain text chunks, not a JSON envelope,
 * closing with code 1000 once the job finishes. No automatic reconnect on an abnormal close yet: a
 * dropped connection (not the job finishing) just stops the live tail, with a button to resume it.
 */
export function JobLogPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<JobView | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  // Bumped by the effect's cleanup, so a `connect()` left over from a fast remount or a fast
  // job-to-job navigation (its awaits still pending) never applies its result once superseded —
  // found by review: without this, two overlapping connects could leak a socket and cross the log
  // of one job into the page now showing a different one.
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
      const socket = new WebSocket(`${scheme}//${location.host}/v1/jobs/${encodeURIComponent(id)}/stream?ticket=${ticket}&from=${initial.nextFrom}`);
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

  if (!jobId) return null;

  return (
    <div className="panel">
      <p>
        <Link to="/mobile/jobs">&larr; Jobs</Link>
      </p>
      <div className="panel-header">
        <h2>{job?.target ?? jobId}</h2>
        {job && <StatusBadge status={job.status} />}
        {live && <span className="badge badge-info">en vivo</span>}
      </div>
      {job && (
        <p className="muted">
          {job.ref} · {job.sha.slice(0, 8)} {job.error ? `· ${job.error}` : ""}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!live && job && (job.status === "queued" || job.status === "running") && (
        <button className="btn btn-small" onClick={() => connect(jobId)}>
          Reconectar
        </button>
      )}
      <pre className="log-view">{log || "(sin salida todavía)"}</pre>
    </div>
  );
}
