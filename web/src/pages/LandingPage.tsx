import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/**
 * Both cards always show, for every role: which one a role unlocks is `ProtectedRoute`'s job, not
 * this page's. Cypress is disabled for everyone, admin included — there is nothing built for it yet
 * (STA-34 scoped this explicitly to mobile only), not a role restriction.
 */
export function LandingPage() {
  const { state, logout } = useAuth();
  if (state.status !== "authenticated") return null;
  const canMobile = state.role === "e2e-mobile" || state.role === "admin";

  return (
    <div className="landing">
      <header className="landing-header">
        <span>
          {state.username} · {state.role}
        </span>
        <button className="btn" onClick={() => logout()}>
          Salir
        </button>
      </header>
      <div className="card-grid">
        {canMobile ? (
          <Link to="/mobile" className="card card-link">
            <h3>Mobile (Detox)</h3>
            <p className="muted">Escenarios, jobs y reportes de las corridas E2E de la app móvil.</p>
          </Link>
        ) : (
          <div className="card card-disabled" title="Tu rol no tiene acceso a Mobile">
            <h3>Mobile (Detox)</h3>
            <p className="muted">Tu rol no tiene acceso.</p>
          </div>
        )}
        <div className="card card-disabled" title="Todavía no está construido">
          <h3>Cypress (web)</h3>
          <p className="muted">Próximamente.</p>
        </div>
      </div>
    </div>
  );
}
