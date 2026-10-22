import type { JobStatus, Outcome } from "../api/types";

const STATUS_CLASS: Record<JobStatus, string> = {
  queued: "badge-muted",
  running: "badge-info",
  cancelling: "badge-warning",
  succeeded: "badge-success",
  failed: "badge-danger",
  cancelled: "badge-muted",
};

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "En cola",
  running: "Corriendo",
  cancelling: "Cancelando",
  succeeded: "Terminado",
  failed: "Falló",
  cancelled: "Cancelado",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

const OUTCOME_CLASS: Record<Outcome, string> = {
  success: "badge-success",
  warning: "badge-warning",
  failure: "badge-danger",
};

export function OutcomeBadge({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return <span className={`badge ${OUTCOME_CLASS[outcome]}`}>{outcome}</span>;
}
