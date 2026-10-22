import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

export const DETOX_PROJECT = "detox";

export function MobileLayout() {
  const { state, logout } = useAuth();

  return (
    <div className="app-shell">
      <nav className="navbar">
        <NavLink to="/mobile/escenarios" className="navlink">
          Escenarios
        </NavLink>
        <NavLink to="/mobile/jobs" className="navlink">
          Jobs
        </NavLink>
        <NavLink to="/mobile/reportes" className="navlink">
          Reportes
        </NavLink>
        <span className="navbar-spacer" />
        {state.status === "authenticated" && <span className="muted">{state.username}</span>}
        <button className="btn" onClick={() => logout()}>
          Salir
        </button>
      </nav>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
