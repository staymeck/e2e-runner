export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd: string;
  /** Kill the command (and fail) after this long. */
  readonly timeoutMs: number;
  /** Added to the environment the command gets. */
  readonly env?: Readonly<Record<string, string>>;
  /** Variables taken out of the inherited environment (e.g. ones that would redirect git). */
  readonly removeEnv?: readonly string[];
  /**
   * Start from a minimal environment (PATH, HOME, temp folders, locale) instead of the service's own, so a
   * program that runs third-party code never sees the service's secrets.
   */
  readonly minimalEnv?: boolean;
}

/** `https://token@host/x` -> `https://***@host/x`: tools echo remote URLs in their errors. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      redactCredentials(
        `${command} ${args.slice(0, 2).join(" ")} failed (${exitCode === null ? "no exit code" : `exit ${exitCode}`}): ${stderr.trim().slice(0, 500)}`,
      ),
    );
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
