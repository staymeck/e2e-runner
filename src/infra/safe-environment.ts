/**
 * Names the service's own secrets are read from; a child process must never see them.
 * Exported so a caller that lets `CommandRunner` rebuild the environment from its own `process.env`
 * (`minimalEnv: false`) can also pass this as `removeEnv`: omitting a key from the environment given to
 * `run` does not delete it if the runner independently copies it back in from `process.env`.
 */
export const SERVICE_SECRET_NAMES: readonly string[] = ["E2E_SERVICE_API_KEY", "E2E_SERVICE_API_KEY_NEXT", "E2E_WEB_USERS"];

/** The service's environment, minus its own secrets, for processes it starts on a project's behalf. */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SERVICE_SECRET_NAMES.includes(name)) result[name] = value;
  }
  return result;
}
