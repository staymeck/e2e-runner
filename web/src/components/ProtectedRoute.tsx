import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { WebRole } from "../api/types";

interface Props {
  readonly roles?: readonly WebRole[];
  readonly children: ReactNode;
}

/** Redirects to `/login` with no session, or to `/` when logged in but not in one of `roles`. */
export function ProtectedRoute({ roles, children }: Props) {
  const { state } = useAuth();

  if (state.status === "loading") return <div className="panel">Cargando…</div>;
  if (state.status === "anonymous") return <Navigate to="/login" replace />;
  if (roles && state.role !== "admin" && !roles.includes(state.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
