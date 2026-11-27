export const PUBLIC_BASE_URL = Symbol("PUBLIC_BASE_URL");

/**
 * Where a webhook's own links.*, or any other absolute link this service hands out, must point —
 * never `config.server.host`/`port` directly: those are what this process binds to, which a reverse
 * proxy (or Docker) usually makes unreachable from outside. Unset (the common case behind a
 * path-prefixing proxy, same as E2E_RUNNER_WEB_BASE for the web/STA-51), falls back to the bind
 * address — correct only for a setup with nothing in front of this service.
 */
export function publicBaseUrl(host: string, port: number): string {
  return process.env.E2E_SERVICE_PUBLIC_URL?.trim() || `http://${host}:${port}`;
}
