import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandRunner } from "../core/command-runner";
import type { ProcessExit, ProcessHost, RunningProcess, StartOptions } from "../core/process-host";

const PS_TIMEOUT_MS = 5000;

/**
 * The real ProcessHost. On Linux and macOS each process leads its own group (`detached`), so a signal sent to
 * `-pid` reaches the whole tree (node -> python -> docker client). Windows has no process groups: there the
 * process itself is signalled, and the service is not meant to be deployed there.
 */
export class NodeProcessHost implements ProcessHost {
  constructor(private readonly runner: CommandRunner) {}

  start(command: string, args: readonly string[], options: StartOptions): RunningProcess {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const exit = new Promise<ProcessExit>((resolve) => {
      let settled = false;
      const done = (result: ProcessExit): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8"); // a character split across two chunks must not be corrupted
        stream?.on("data", (chunk: Buffer) => this.deliver(options, decoder.write(chunk)));
        stream?.on("end", () => this.deliver(options, decoder.end()));
      }
      child.on("error", (error) => done({ code: null, signal: null, spawnError: error.message }));
      child.on("close", (code, signal) => done({ code, signal }));
    });
    return { pid: child.pid, exit };
  }

  kill(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch {
      // already gone (ESRCH) or not ours to signal (EPERM): nothing more to do
    }
  }

  async commandLine(pid: number): Promise<string | undefined> {
    if (process.platform === "win32") return undefined; // cannot be told: callers must then not kill by id
    try {
      const { stdout } = await this.runner.run("ps", ["-o", "command=", "-p", String(pid)], { cwd: "/", timeoutMs: PS_TIMEOUT_MS });
      return stdout.trim() || undefined;
    } catch {
      return undefined; // ps exits 1 when there is no such process
    }
  }

  private deliver(options: StartOptions, text: string): void {
    if (!text) return;
    try {
      options.onOutput(text);
    } catch {
      // the log must never take the run down
    }
  }
}
