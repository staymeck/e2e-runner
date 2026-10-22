import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { DETOX_PROJECT, type CatalogTarget } from "../../api/types";

export function EscenariosPage() {
  const [refs, setRefs] = useState<string[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [targets, setTargets] = useState<CatalogTarget[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server has exactly one browsing position for the whole catalog (see docs/design.md §2.3):
  // picking a different branch before the previous browse->targets round-trip finished must not let
  // a slower, now-stale response overwrite what a newer selection already resolved — found by review.
  const browseGeneration = useRef(0);

  useEffect(() => {
    Promise.all([api.projects.list(), api.projects.refs(DETOX_PROJECT)])
      .then(([{ projects }, { refs: loaded }]) => {
        setRefs(loaded);
        const project = projects.find((p) => p.id === DETOX_PROJECT);
        setBranch(project?.defaultBranch ?? loaded[0] ?? null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const browse = useCallback((ref: string) => {
    const generation = ++browseGeneration.current;
    const isCurrent = () => browseGeneration.current === generation;
    setError(null);
    api.projects
      .browse(DETOX_PROJECT, ref)
      .then(({ sha: positioned }) => {
        if (!isCurrent()) return undefined;
        setSha(positioned);
        return api.projects.targets(DETOX_PROJECT);
      })
      .then((result) => {
        if (result && isCurrent()) setTargets(result.targets);
      })
      .catch((err) => {
        if (isCurrent()) setError(errorMessage(err));
      });
  }, []);

  useEffect(() => {
    if (branch) browse(branch);
  }, [branch, browse]);

  const onFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      await api.projects.fetch(DETOX_PROJECT);
      const { refs: loaded } = await api.projects.refs(DETOX_PROJECT);
      setRefs(loaded);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Escenarios</h2>
      </div>
      <div className="field-row">
        <label>
          Rama
          <select value={branch ?? ""} onChange={(e) => setBranch(e.target.value)}>
            {(refs ?? []).map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-small" onClick={onFetch} disabled={fetching}>
          {fetching ? "Buscando…" : "Fetch"}
        </button>
        {sha && <span className="muted mono">{sha.slice(0, 8)}</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {!targets ? (
        <p className="muted">Cargando…</p>
      ) : targets.length === 0 ? (
        <p className="muted">Esta rama no tiene escenarios.</p>
      ) : (
        <div className="card-grid">
          {targets.map((target) => (
            <Link key={target.id} to={`/mobile/escenarios/${encodeURIComponent(target.id)}?ref=${encodeURIComponent(branch ?? "")}`} className="card card-link">
              <h3>{target.title ?? target.id}</h3>
              {target.title && <p className="muted">{target.id}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
