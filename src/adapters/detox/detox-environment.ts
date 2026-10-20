/** The service's own settings, which a catalog's code has no business seeing (the API key above all). */
const SERVICE_PREFIX = "E2E_SERVICE_";

/**
 * The environment `perfect-qa` runs in: the service's own, because it needs PATH, ANDROID_HOME, docker settings
 * and so on, minus the service's configuration. Anything the catalog needs of its own comes from its `.env`.
 */
export function catalogEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.toUpperCase().startsWith(SERVICE_PREFIX)) continue;
    env[name] = value;
  }
  return env;
}
