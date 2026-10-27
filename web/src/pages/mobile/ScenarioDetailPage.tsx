import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { DETOX_PROJECT, type ApkScenarioStatus, type JobView } from "../../api/types";
import { StatusBadge } from "../../components/StatusBadge";
import { usePolling } from "../../usePolling";

const POLL_MS = 3000;
const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

/** Every app (or batch `customId`) a `build`/`pipeline` job still queued or running right now is
 * (re)compiling. `all: true` means a full-scenario build with no `only` filter — every app in the
 * table counts as compiling. A `pipeline` queued with `params.build === false` never has a build
 * phase at all (see `planDetoxPhases` in `detox-request.ts`), so it never counts, even without `only`. */
function activeBuilds(jobs: readonly JobView[]): { all: boolean; apps: ReadonlySet<string> } {
  let all = false;
  const apps = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== "build" && job.kind !== "pipeline") continue;
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    const params = job.params as { only?: unknown; build?: unknown } | null;
    if (job.kind === "pipeline" && params?.build === false) continue;
    const only = params?.only;
    if (Array.isArray(only) && only.every((a) => typeof a === "string")) {
      for (const a of only as string[]) apps.add(a);
    } else {
      all = true;
    }
  }
  return { all, apps };
}

/**
 * The orchestrator's own scenario-detail page lets you edit a per-app branch/ws-host APK plan
 * (STA-44/45) — that model does not exist in this service yet, so there is nothing to port there.
 * What this page offers today, backed by what the service actually has: compile the scenario (whole
 * or one app at a time), run it once every app is built, and the live/recent queue of its own jobs.
 */
export function ScenarioDetailPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const [searchParams] = useSearchParams();
  const ref = searchParams.get("ref") ?? undefined;
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [apkStatus, setApkStatus] = useState<ApkScenarioStatus | null | undefined>(undefined);
  const [triggering, setTriggering] = useState(false);
  const [compilingApp, setCompilingApp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!scenarioId) return;
    api.jobs
      .list({ project: DETOX_PROJECT, target: scenarioId, limit: 20 })
      .then((result) => setJobs(result.jobs))
      .catch((err) => setError(errorMessage(err)));
    // A missing apk-status (an old catalog branch, or this project having none) must never block the
    // page or "Ejecutar" — same fail-open the server's own `checkReady` already applies.
    api.projects
      .apkStatus(DETOX_PROJECT, scenarioId)
      .then((result) => setApkStatus(result.status))
      .catch(() => setApkStatus(null));
  }, [scenarioId]);

  usePolling(load, POLL_MS);

  if (!scenarioId) return null;

  const building = activeBuilds(jobs ?? []);
  const notReadyApps = (apkStatus?.apps ?? []).filter((a) => !a.ready).map((a) => a.app);
  const canRun = apkStatus === null || notReadyApps.length === 0;

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

  const onCompile = async (only?: string) => {
    setCompilingApp(only ?? "__all__");
    setError(null);
    try {
      await api.jobs.submit({
        project: DETOX_PROJECT,
        target: scenarioId,
        kind: "build",
        ...(ref ? { ref } : {}),
        ...(only ? { params: { only: [only] } } : {}),
      });
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCompilingApp(null);
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

      {apkStatus && apkStatus.apps.length > 0 && (
        <>
          <h3>Apps</h3>
          <table className="table">
            <thead>
              <tr>
                <th>App</th>
                <th>Rama</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apkStatus.apps.map((row, i) => {
                // `build-apk.py`'s `--only` matches a batch row's `customId` as well as its app name
                // (see `expand_apk_production` in `scripts/build-apk.py`) — using the app name alone
                // for a row that has a `customId` would recompile every row sharing that app name,
                // not just the one clicked (a batch can use the same app on several branches/slots).
                const rowId = row.customId ?? row.app;
                const compiling = building.all || building.apps.has(rowId);
                return (
                  <tr key={`${row.app}-${row.customId ?? i}`}>
                    <td>
                      {row.app}
                      {row.customId && <span className="muted"> ({row.customId})</span>}
                    </td>
                    <td className="mono">{row.branch}</td>
                    <td>
                      {compiling ? (
                        <span className="badge badge-info">Compilando…</span>
                      ) : row.ready ? (
                        <span className="badge badge-success">Ready</span>
                      ) : (
                        <span className="badge badge-warning">Not Ready</span>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-small" onClick={() => onCompile(rowId)} disabled={compiling || compilingApp !== null}>
                        {compilingApp === rowId ? "Encolando…" : "Recompilar app"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <div className="field-row">
        <button className="btn btn-primary" onClick={onRun} disabled={triggering || !canRun}>
          {triggering ? "Encolando…" : "Ejecutar escenario"}
        </button>
        <button className="btn" onClick={() => onCompile()} disabled={compilingApp !== null}>
          {compilingApp === "__all__" ? "Encolando…" : "Compilar"}
        </button>
      </div>
      {!canRun && (
        <p className="muted">
          No se puede ejecutar: falta compilar {notReadyApps.join(", ")}.
        </p>
      )}

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
