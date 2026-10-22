import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { DETOX_PROJECT, type JobView } from "../../api/types";
import { StatusBadge } from "../../components/StatusBadge";
import { usePolling } from "../../usePolling";

const POLL_MS = 3000;

/**
 * The orchestrator's own scenario-detail page lets you edit a per-app branch/ws-host APK plan
 * (STA-44/45) — that model does not exist in this service yet, so there is nothing to port there.
 * What this page offers today, backed by what the service actually has: run the scenario on the
 * branch it was reached from (Escenarios), and the live/recent queue of its own jobs.
 */
export function ScenarioDetailPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const [searchParams] = useSearchParams();
  const ref = searchParams.get("ref") ?? undefined;
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!scenarioId) return;
    api.jobs
      .list({ project: DETOX_PROJECT, target: scenarioId, limit: 20 })
      .then((result) => setJobs(result.jobs))
      .catch((err) => setError(errorMessage(err)));
  }, [scenarioId]);

  usePolling(load, POLL_MS);

  if (!scenarioId) return null;

  const onRun = async () => {
    setTriggering(true);
    setError(null);
    try {
      await api.jobs.submit({ project: DETOX_PROJECT, target: scenarioId, kind: "run", ...(ref ? { ref } : {}) });
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="panel">
      <p>
        <Link to="/mobile/escenarios">&larr; Escenarios</Link>
      </p>
      <div className="panel-header">
        <h2>{scenarioId}</h2>
      </div>
      {ref && <p className="muted">rama: {ref}</p>}
      {error && <p className="error">{error}</p>}
      <div className="field-row">
        <button className="btn btn-primary" onClick={onRun} disabled={triggering}>
          {triggering ? "Encolando…" : "Ejecutar escenario"}
        </button>
      </div>

      <h3>Jobs de este escenario</h3>
      {!jobs ? (
        <p className="muted">Cargando…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">Todavía no se encoló ningún job de este escenario.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Rama</th>
              <th>Commit</th>
              <th>Estado</th>
              <th>Fase</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.ref}</td>
                <td className="mono">{job.sha.slice(0, 8)}</td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
                <td>{job.phase ?? "—"}</td>
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
