import { execFile } from "node:child_process";
import { CommandFailedError, type CommandOptions, type CommandResult, type CommandRunner } from "../core/command-runner";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** What a program needs to run at all, and nothing that looks like a secret. */
const MINIMAL_ENV_NAMES: readonly string[] = [
  "PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "ComSpec", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ",
];

function environment(options: CommandOptions): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!options.minimalEnv || MINIMAL_ENV_NAMES.includes(name)) base[name] = value;
  }
  for (const name of options.removeEnv ?? []) delete base[name];
  return { ...base, ...options.env };
}

/** The real CommandRunner: `execFile` (no shell), with a timeout and a bounded output. */
export class ExecCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env: environment(options) },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr });
          const code = (error as { code?: unknown }).code;
          const exitCode = typeof code === "number" ? code : null;
          const overflow = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const reason = overflow ? "output exceeded the size limit" : error.killed ? `timed out after ${options.timeoutMs} ms` : stderr || error.message;
          reject(new CommandFailedError(command, args, exitCode, reason));
        },
      );
    });
  }
}
