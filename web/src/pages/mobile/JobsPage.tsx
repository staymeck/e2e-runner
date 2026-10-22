import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import type { JobStatus, JobView } from "../../api/types";
import { StatusBadge } from "../../components/StatusBadge";
import { DETOX_PROJECT } from "./MobileLayout";

const POLL_MS = 3000;
const STATUS_FILTERS: readonly JobStatus[] = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled"];

export function JobsPage() {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [ref, setRef] = useState("");
  const [status, setStatus] = useState<JobStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.jobs
      .list({ project: DETOX_PROJECT, ref: ref || undefined, statuses: status ? [status] : undefined, limit: 100 })
      .then((result) => setJobs(result.jobs))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [ref, status]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const onCancel = async (id: string) => {
    setBusy(id);
    try {
      await api.jobs.cancel(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onRetry = async (id: string) => {
    setBusy(id);
    try {
      await api.jobs.retry(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Jobs</h2>
      </div>
      <div className="field-row">
        <label>
          Rama
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="todas" />
        </label>
        <label>
          Estado
          <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | "")}>
            <option value="">todos</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!jobs ? (
        <p className="muted">Cargando…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">No hay jobs con esos filtros.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Escenario</th>
              <th>Rama</th>
              <th>Commit</th>
              <th>Estado</th>
              <th>Fase</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const terminal = job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
              const cancellable = job.status === "queued" || job.status === "running";
              return (
                <tr key={job.id}>
                  <td>
                    <Link to={`/mobile/jobs/${encodeURIComponent(job.id)}`}>{job.target}</Link>
                  </td>
                  <td>{job.ref}</td>
                  <td className="mono">{job.sha.slice(0, 8)}</td>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  <td>{job.phase ?? "—"}</td>
                  <td className="row-actions">
                    {cancellable && (
                      <button className="btn btn-small" disabled={busy === job.id} onClick={() => onCancel(job.id)}>
                        Cancelar
                      </button>
                    )}
                    {terminal && (
                      <button className="btn btn-small" disabled={busy === job.id} onClick={() => onRetry(job.id)}>
                        Reintentar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
