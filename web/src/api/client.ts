import { getStoredSession } from "./session";
import type { CatalogTarget, DeviceStatus, JobStatus, JobView, LoginResult, MeResult, ProjectView } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = getStoredSession();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    } catch {
      // ignore a non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Only `login` goes through here directly: it is the one call made before a session token exists. */
async function requestNoAuth<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // ignore a non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface JobListFilter {
  readonly project?: string;
  readonly ref?: string;
  readonly target?: string;
  readonly statuses?: readonly JobStatus[];
  readonly limit?: number;
  readonly before?: number;
}

function queryOf(filter: JobListFilter): string {
  const params = new URLSearchParams();
  if (filter.project) params.set("project", filter.project);
  if (filter.ref) params.set("ref", filter.ref);
  if (filter.target) params.set("target", filter.target);
  if (filter.statuses && filter.statuses.length > 0) params.set("status", filter.statuses.join(","));
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.before) params.set("before", String(filter.before));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export interface SubmitJob {
  readonly project: string;
  readonly target: string;
  readonly ref?: string;
  readonly kind?: string;
  readonly params?: unknown;
}

export const api = {
  auth: {
    login: (username: string, password: string) => requestNoAuth<LoginResult>("/v1/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
    logout: () => request<void>("/v1/auth/logout", { method: "POST" }),
    me: () => request<MeResult>("/v1/auth/me"),
  },

  projects: {
    list: () => request<{ projects: ProjectView[] }>("/v1/projects"),
    fetch: (id: string) => request<Record<string, never>>(`/v1/projects/${encodeURIComponent(id)}/fetch`, { method: "POST" }),
    refs: (id: string) => request<{ refs: string[] }>(`/v1/projects/${encodeURIComponent(id)}/refs`),
    browse: (id: string, ref: string) => request<{ ref: string; sha: string }>(`/v1/projects/${encodeURIComponent(id)}/browse`, { method: "POST", body: JSON.stringify({ ref }) }),
    targets: (id: string) => request<{ targets: CatalogTarget[] }>(`/v1/projects/${encodeURIComponent(id)}/targets`),
    devices: (id: string) => request<{ devices: DeviceStatus[] }>(`/v1/projects/${encodeURIComponent(id)}/devices`),
  },

  jobs: {
    submit: (body: SubmitJob) => request<JobView>("/v1/jobs", { method: "POST", body: JSON.stringify(body) }),
    list: (filter: JobListFilter = {}) => request<{ jobs: JobView[]; nextCursor: number | null }>(`/v1/jobs${queryOf(filter)}`),
    get: (id: string) => request<JobView>(`/v1/jobs/${encodeURIComponent(id)}`),
    cancel: (id: string) => request<JobView>(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    retry: (id: string) => request<JobView>(`/v1/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    log: (id: string, from = 0) => request<{ text: string; nextFrom: number }>(`/v1/jobs/${encodeURIComponent(id)}/log?from=${from}`),
    streamTicket: (id: string) => request<{ ticket: string }>(`/v1/jobs/${encodeURIComponent(id)}/stream-ticket`, { method: "POST" }),
  },
};
