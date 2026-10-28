import { useParams, Link } from "react-router-dom";
import { LogView } from "../../components/LogView";
import { StatusBadge } from "../../components/StatusBadge";
import { useJobLog } from "../../useJobLog";

export function JobLogPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { job, log, live, error, reconnect } = useJobLog(jobId);

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
        <button className="btn btn-small" onClick={reconnect}>
          Reconectar
        </button>
      )}
      <LogView text={log} />
    </div>
  );
}
