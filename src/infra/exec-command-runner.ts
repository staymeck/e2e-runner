import { execFile } from "node:child_process";
import { CommandFailedError, type CommandOptions, type CommandResult, type CommandRunner } from "../core/command-runner";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The real CommandRunner: `execFile` (no shell), with a timeout and a bounded output. */
export class ExecCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: { ...process.env, ...options.env },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr });
          const exitCode = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
          const reason = error.killed ? `timed out after ${options.timeoutMs} ms` : stderr || error.message;
          reject(new CommandFailedError(command, args, exitCode, reason));
        },
      );
    });
  }
}
