import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { openReport } from "../../api/openReport";
import { DETOX_PROJECT } from "../../api/types";
import { LogView } from "../../components/LogView";
import { StatusBadge } from "../../components/StatusBadge";
import { useJobLog } from "../../useJobLog";

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;

/**
 * The job-detail page for Historial (and the "last job" link from ScenarioDetailPage): logs, a way to
 * re-run the same scenario, and this job's own report — all three together, so Historial does not need
 * a separate Reportes tab/page for the one thing it was missing (STA — general report).
 */
export function JobLogPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { job, log, live, error, reconnect } = useJobLog(jobId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);

  if (!jobId) return null;

  const terminal = job && (TERMINAL as readonly string[]).includes(job.status);

  const onRerun = async () => {
    if (!job) return;
    setRerunning(true);
    setActionError(null);
    try {
      // A fresh submit, not api.jobs.retry: retry pins the exact same commit already run, which proves
      // nothing new — "ejecutar escenario de nuevo" means against the branch's current tip.
      const next = await api.jobs.submit({ project: DETOX_PROJECT, target: job.target, kind: "run", ref: job.ref });
      window.location.assign(`/mobile/jobs/${encodeURIComponent(next.id)}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div className="panel">
      <p>
        <Link to="/mobile/historial">&larr; Historial</Link>
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
      {actionError && <p className="error">{actionError}</p>}
      <div className="field-row field-row-spaced">
        {!live && job && (job.status === "queued" || job.status === "running") && (
          <button className="btn btn-small" onClick={reconnect}>
            Reconectar
          </button>
        )}
        {terminal && (
          <button className="btn btn-small" disabled={rerunning} onClick={onRerun}>
            {rerunning ? "Encolando…" : "Ejecutar escenario"}
          </button>
        )}
        {job?.hasReport && (
          <button className="btn btn-small" onClick={() => openReport(job.id, setActionError)}>
            Ver reporte
          </button>
        )}
      </div>
      <LogView text={log} />
    </div>
  );
}
