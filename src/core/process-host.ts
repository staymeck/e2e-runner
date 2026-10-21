export interface ProcessExit {
  /** Exit code, or null when the process was ended by a signal or could not start. */
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started at all (program not found, bad directory). */
  readonly spawnError?: string;
}

export interface StartOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Everything the process prints (stdout and stderr, interleaved as it arrives), as it arrives. */
  readonly onOutput: (text: string) => void;
}

export interface RunningProcess {
  readonly pid: number | undefined;
  /** Never rejects. */
  readonly exit: Promise<ProcessExit>;
}

/**
 * Starts long-running programs as the head of their own process group, so everything they start can be
 * stopped with them, and can look at (and stop) a process by id after the service itself died.
 */
export interface ProcessHost {
  start(command: string, args: readonly string[], options: StartOptions): RunningProcess;
  /** Sends the signal to the process and everything it started. A process that is already gone is not an error. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** The command line of a running process, or undefined when there is none (or it cannot be told). */
  commandLine(pid: number): Promise<string | undefined>;
}
