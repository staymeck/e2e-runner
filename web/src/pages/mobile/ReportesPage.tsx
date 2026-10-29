import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { DETOX_PROJECT, type JobView } from "../../api/types";
import { OutcomeBadge, StatusBadge } from "../../components/StatusBadge";
import { usePolling } from "../../usePolling";

const POLL_MS = 5000;
const FINISHED = ["succeeded", "failed", "cancelled"] as const;

/**
 * Fetches the report as a blob (it needs our own Authorization, a plain link cannot carry one) and
 * opens it in a new tab. The tab is opened synchronously, on the click itself, with nothing in it yet
 * — popup blockers key off that synchronous "user activation" moment, and opening it only after the
 * `await fetch` below (found by review) loses it, so the tab is silently blocked whenever the fetch
 * takes any real time at all. It is then pointed at the blob once the fetch resolves, instead.
 *
 * Deliberately never revokes the blob URL: the tab keeps using it for as long as it stays open (it
 * may well still be loading embedded screenshots/video from the Detox report when this call returns),
 * and there is no reliable, synchronous "the tab is done with it now" signal across tabs to revoke on.
 * The cost is one held blob per report a person actually opens in this browser tab's lifetime — opened
 * by a human clicking a button, not in a loop, so this never grows unbounded in practice.
 */
function openReport(jobId: string, onError: (message: string) => void): void {
  const tab = window.open("", "_blank");
  if (!tab) {
    onError("El navegador bloqueó la ventana nueva: permite ventanas emergentes para este sitio.");
    return;
  }
  api.jobs
    .reportUrl(jobId)
    .then((url) => {
      tab.location.href = url;
    })
    .catch((err) => {
      tab.close();
      onError(errorMessage(err));
    });
}

export function ReportesPage() {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.jobs
      .list({ project: DETOX_PROJECT, statuses: FINISHED, limit: 100 })
      .then((result) => setJobs(result.jobs))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  usePolling(load, POLL_MS);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Reportes</h2>
      </div>
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
                  {job.hasReport && (
                    <>
                      {" · "}
                      <a href="#" onClick={(e) => (e.preventDefault(), openReport(job.id, setError))}>
                        Ver reporte
                      </a>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
