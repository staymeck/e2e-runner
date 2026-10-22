import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
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
  const offsetRef = useRef(0);

  const connect = async (id: string) => {
    try {
      const initial = await api.jobs.log(id, 0);
      setLog(initial.text);
      offsetRef.current = initial.nextFrom;

      const { ticket } = await api.jobs.streamTicket(id);
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${location.host}/v1/jobs/${encodeURIComponent(id)}/stream?ticket=${ticket}&from=${offsetRef.current}`);
      socketRef.current = socket;
      socket.onopen = () => setLive(true);
      socket.onmessage = (event) => setLog((current) => current + String(event.data));
      socket.onclose = () => {
        setLive(false);
        socketRef.current = null;
      };
      socket.onerror = () => setError("La conexión en vivo se interrumpió");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!jobId) return;
    api.jobs
      .get(jobId)
      .then(setJob)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    connect(jobId);
    return () => socketRef.current?.close();
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
