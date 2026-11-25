import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecutionProfile } from "./types.js";

export type ExecResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutDroppedBytes?: number;
  stderrDroppedBytes?: number;
};

export const CHILD_OUTPUT_TAIL_BYTES = 1024 * 1024;
export const ERROR_STDERR_TAIL_BYTES = 2 * 1024;

export type ExecOptions = { cwd?: string; timeoutMs?: number; input?: string; execution?: ExecutionProfile };

export function execShell(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const child = options.execution
    ? spawn(options.execution.shell, [...options.execution.shellArgs, command], {
        cwd: options.cwd,
        env: executionEnv(options.execution),
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(command, {
        cwd: options.cwd,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
  return collectChild(child, options);
}

/**
 * Executes a binary with an argv array and no shell, so argument values
 * (webhook payloads, comment bodies, templated strings) can never be
 * interpreted as shell syntax.
 */
export function execArgv(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.execution ? executionEnv(options.execution) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return collectChild(child, options);
}

function collectChild(child: ChildProcessWithoutNullStreams, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const stdout = new OutputTail(CHILD_OUTPUT_TAIL_BYTES);
    const stderr = new OutputTail(CHILD_OUTPUT_TAIL_BYTES);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 1_000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const out = stdout.finish();
      const err = stderr.finish();
      resolve({
        exitCode,
        signal,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        ...(out.droppedBytes > 0 ? { stdoutDroppedBytes: out.droppedBytes } : {}),
        ...(err.droppedBytes > 0 ? { stderrDroppedBytes: err.droppedBytes } : {}),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

class OutputTail {
  private chunks: Buffer[] = [];
  private keptBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.keptBytes += chunk.length;
    while (this.chunks.length > 1) {
      const oldest = this.chunks[0];
      if (!oldest || this.keptBytes - oldest.length < this.limit) break;
      this.chunks.shift();
      this.keptBytes -= oldest.length;
      this.droppedBytes += oldest.length;
    }
  }

  finish(): { text: string; droppedBytes: number } {
    const kept = Buffer.concat(this.chunks);
    const excess = Math.max(0, kept.length - this.limit);
    return { text: kept.subarray(excess).toString("utf8"), droppedBytes: this.droppedBytes + excess };
  }
}

export function stderrTail(result: ExecResult, limit = ERROR_STDERR_TAIL_BYTES): string {
  const text = Buffer.from(result.stderr.trim(), "utf8");
  const start = Math.max(0, text.length - limit);
  const cut = start + (result.stderrDroppedBytes ?? 0);
  const tail = text.subarray(start).toString("utf8");
  return cut > 0 ? `[${cut} earlier bytes cut] ${tail}` : tail;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function executionEnv(profile: ExecutionProfile): NodeJS.ProcessEnv {
  return {
    ...(profile.inheritEnv ? process.env : {}),
    ...profile.env,
  };
}
