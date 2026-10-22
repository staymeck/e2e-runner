import type { WebRole } from "./types";

const STORAGE_KEY = "e2e-runner-session";

export interface StoredSession {
  readonly token: string;
  readonly username: string;
  readonly role: WebRole;
}

export function getStoredSession(): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.token !== "string" || typeof parsed.username !== "string" || typeof parsed.role !== "string") return undefined;
    return { token: parsed.token, username: parsed.username, role: parsed.role as WebRole };
  } catch {
    return undefined;
  }
}

export function setStoredSession(session: StoredSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
