import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import type { JobView } from "../../api/types";
import { OutcomeBadge, StatusBadge } from "../../components/StatusBadge";
import { DETOX_PROJECT } from "./MobileLayout";

const POLL_MS = 5000;
const FINISHED = ["succeeded", "failed", "cancelled"] as const;

/**
 * The service tracks `job.reportPath` internally (src/core/job.ts) but no HTTP endpoint serves it —
 * `buildWebhookPayload` (src/webhooks/payload.ts) deliberately excludes server-side paths from what
 * leaves the process, and nothing in STA-31/42/43 added a report-serving route either. This page
 * shows the finished jobs a report would belong to; opening the report itself needs a new endpoint
 * that does not exist yet (worth raising as a follow-up, not something to guess the shape of here).
 */
export function ReportesPage() {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.jobs
      .list({ project: DETOX_PROJECT, statuses: FINISHED, limit: 100 })
      .then((result) => setJobs(result.jobs))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Reportes</h2>
      </div>
      <p className="muted">
        Todavía no hay un endpoint que sirva el contenido del reporte (solo el estado y el resultado). Por ahora, esta pestaña lista los jobs terminados; abrir el reporte en sí queda
        pendiente.
      </p>
      {error && <p className="error">{error}</p>}
      {!jobs ? (
        <p className="muted">Cargando…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">Todavía no hay jobs terminados.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Escenario</th>
              <th>Rama</th>
              <th>Commit</th>
              <th>Estado</th>
              <th>Resultado</th>
              <th>Terminó</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.target}</td>
                <td>{job.ref}</td>
                <td className="mono">{job.sha.slice(0, 8)}</td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
                <td>
                  <OutcomeBadge outcome={job.outcome} />
                </td>
                <td>{job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "—"}</td>
                <td>
                  <Link to={`/mobile/jobs/${encodeURIComponent(job.id)}`}>Ver logs</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
