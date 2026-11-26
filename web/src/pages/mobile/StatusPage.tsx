import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { openReport } from "../../api/openReport";
import type { GeneralReportView } from "../../api/types";
import { OutcomeBadge } from "../../components/StatusBadge";
import { usePolling } from "../../usePolling";

const POLL_MS = 5000;

/**
 * The general report: one row per scenario, always the latest known outcome on the tracked branch —
 * replaces the old Reportes tab. This is the page meant to be shared (the webhook's links.report
 * points here by default, see payload.ts) — a failing row's "Ver reporte" opens that job's own report
 * directly, the same way Historial's job-detail page does (api/openReport.ts).
 */
export function StatusPage() {
  const [report, setReport] = useState<GeneralReportView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.report
      .general()
      .then(setReport)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  usePolling(load, POLL_MS);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Status</h2>
        {report && <span className="muted">rama: {report.branch}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {!report ? (
        <p className="muted">Cargando…</p>
      ) : report.scenarios.length === 0 ? (
        <p className="muted">Todavía no hay corridas en la rama "{report.branch}".</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Escenario</th>
              <th>Estado</th>
              <th>Última corrida</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {report.scenarios.map((entry) => (
              <tr key={entry.target}>
                <td>{entry.target}</td>
                <td>
                  <OutcomeBadge outcome={entry.latestOutcome} />
                </td>
                <td>{new Date(entry.latestFinishedAt).toLocaleString()}</td>
                <td>
                  <Link to={`/mobile/jobs/${encodeURIComponent(entry.latestJobId)}`}>Ver job</Link>
                  {" · "}
                  <a href="#" onClick={(e) => (e.preventDefault(), openReport(entry.latestJobId, setError))}>
                    Ver reporte
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
