import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { clearStoredSession, getStoredSession, setStoredSession, type StoredSession } from "../api/session";
import type { WebRole } from "../api/types";

type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly username: string; readonly role: WebRole };

interface AuthContextValue {
  readonly state: AuthState;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * On mount, a stored session token is re-checked against `/v1/auth/me` (not just trusted as-is): it
 * may have been revoked server-side (logout from another tab, or the service restarted — sessions
 * are in memory, see docs/design.md §6) since it was written to localStorage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    // Guards every outcome with "only while still loading": a fast login()/logout() made in the
    // meantime already set a real state, which this check must never stomp back to anonymous once
    // its own (now-stale) network call finally resolves — found by review.
    const stored = getStoredSession();
    if (!stored) {
      setState((previous) => (previous.status === "loading" ? { status: "anonymous" } : previous));
      return;
    }
    api.auth
      .me()
      .then((me) =>
        setState((previous) =>
          previous.status !== "loading" ? previous : me.kind === "user" ? { status: "authenticated", username: me.username, role: me.role } : { status: "anonymous" },
        ),
      )
      .catch(() => {
        setState((previous) => {
          if (previous.status !== "loading") return previous;
          clearStoredSession();
          return { status: "anonymous" };
        });
      });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.auth.login(username, password);
    const session: StoredSession = { token: result.token, username: result.username, role: result.role };
    setStoredSession(session);
    setState({ status: "authenticated", username: session.username, role: session.role });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Already invalid or expired: still clear the local copy below.
    }
    clearStoredSession();
    setState({ status: "anonymous" });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside an AuthProvider");
  return value;
}
