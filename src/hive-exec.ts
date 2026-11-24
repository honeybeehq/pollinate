import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { execArgv, type ExecOptions, type ExecResult } from "./process.js";

export const DEFAULT_HIVE_STARTING_WAIT_MS = 15 * 60_000;
const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const HEALTH_EXIT_STARTING = 75;

export type HiveStartingRefusal = {
  label: string;
  attempt: number;
  waitedMs: number;
  retryInMs: number;
  message: string;
  phase?: string;
};

export type HiveStartingObserver = {
  onRefused(refusal: HiveStartingRefusal): Promise<void>;
  shouldStop?(): Promise<string | undefined>;
};

export type HiveExecOptions = ExecOptions & {
  label: string;
  startingWaitMs?: number;
};

export class HiveStillStartingError extends Error {
  constructor(
    readonly label: string,
    readonly attempts: number,
    readonly waitedMs: number,
    readonly lastMessage: string,
  ) {
    super(`${label}: Honeybee was still starting after ${formatWait(waitedMs)} and ${attempts} attempts; giving up. Last refusal: ${lastMessage}`);
    this.name = "HiveStillStartingError";
  }
}

const observerScope = new AsyncLocalStorage<HiveStartingObserver>();

export function withHiveStartingObserver<T>(observer: HiveStartingObserver, fn: () => Promise<T>): Promise<T> {
  return observerScope.run(observer, fn);
}

export async function execHive(args: string[], options: HiveExecOptions): Promise<ExecResult> {
  const { label, startingWaitMs = DEFAULT_HIVE_STARTING_WAIT_MS, ...execOptions } = options;
  const observer = observerScope.getStore();
  let firstRefusedAt = 0;
  for (let attempt = 1; ; attempt += 1) {
    const result = await execArgv("hive", args, execOptions);
    const refusal = daemonStartingRefusal(args, result);
    if (!refusal) return result;
    const now = Date.now();
    firstRefusedAt ||= now;
    const waitedMs = now - firstRefusedAt;
    if (waitedMs >= startingWaitMs) throw new HiveStillStartingError(label, attempt, waitedMs, refusal.message);
    const retryInMs = Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS, startingWaitMs - waitedMs);
    await observer?.onRefused({ label, attempt, waitedMs, retryInMs, ...refusal });
    await sleep(retryInMs);
    const stopReason = await observer?.shouldStop?.();
    if (stopReason) throw new Error(`${label}: ${stopReason} while waiting for Honeybee to start`);
  }
}

export function daemonStartingRefusal(args: readonly string[], result: ExecResult): { message: string; phase?: string } | undefined {
  if (result.timedOut || result.exitCode === 0 || result.exitCode === null) return undefined;
  if (args[0] === "health" && result.exitCode === HEALTH_EXIT_STARTING) return { message: firstLine(result.stdout) || "hive health: daemon starting" };
  const fromJson = jsonDaemonStarting(result.stdout);
  if (fromJson) return fromJson;
  const match = /\berror \(daemon_starting\): ([^\n]*)/.exec(result.stderr);
  if (match) return { message: (match[1] ?? "").trim() };
  return undefined;
}

function jsonDaemonStarting(stdout: string): { message: string; phase?: string } | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: { boot?: { phase?: unknown } } } }).error;
    if (error?.code !== "daemon_starting") continue;
    const phase = error.details?.boot?.phase;
    return {
      message: typeof error.message === "string" ? error.message : "daemon_starting",
      ...(typeof phase === "string" ? { phase } : {}),
    };
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
}
