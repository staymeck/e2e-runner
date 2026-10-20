export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd: string;
  /** Kill the command (and fail) after this long. */
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command} ${args.slice(0, 2).join(" ")} failed (${exitCode === null ? "no exit code" : `exit ${exitCode}`}): ${stderr.trim().slice(0, 500)}`);
    this.name = "CommandFailedError";
  }
}

/**
 * Runs a program with an argument list: never through a shell, so nothing in an argument can be
 * interpreted. Rejects with CommandFailedError on a non-zero exit, a timeout or a spawn failure.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}
