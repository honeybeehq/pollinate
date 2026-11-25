import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execArgv, type ExecOptions, type ExecResult } from "./process.js";
import type { Action, ExecutionProfile, Trigger } from "./types.js";

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
  bin?: string;
  startingWaitMs?: number;
};

export const DEFAULT_HIVE_BIN = "hive";
const HIVE_PROBE_TIMEOUT_MS = 2_000;

export type HiveJsonError = { code: string; message: string };

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
  const { label, bin = DEFAULT_HIVE_BIN, startingWaitMs = DEFAULT_HIVE_STARTING_WAIT_MS, ...execOptions } = options;
  const observer = observerScope.getStore();
  let firstRefusedAt = 0;
  for (let attempt = 1; ; attempt += 1) {
    const result = await execArgv(bin, args, execOptions);
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

export function parseHiveJsonError(stdout: string): HiveJsonError | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const error = jsonLineError(line.trim());
    if (typeof error?.code === "string") return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
  }
  return undefined;
}

function jsonLineError(line: string): { code?: unknown; message?: unknown } | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return (JSON.parse(line) as { error?: { code?: unknown; message?: unknown } }).error;
  } catch {
    return undefined;
  }
}

export function resolveHiveBin(bin: string | undefined, execution?: ExecutionProfile): string | undefined {
  const command = bin ?? DEFAULT_HIVE_BIN;
  if (command.includes("/")) return isAbsolute(command) ? command : resolve(command);
  for (const dir of executionPath(execution).split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executionPath(execution?: ExecutionProfile): string {
  if (!execution) return process.env.PATH ?? "";
  return execution.env.PATH ?? (execution.inheritEnv ? (process.env.PATH ?? "") : "");
}

export function actionUsesHive(action: Action | undefined): boolean {
  if (!action) return false;
  if (action.kind === "honeybee") return true;
  if (action.kind === "sequence") return action.actions.some((step) => actionUsesHive(step.action));
  return false;
}

export function triggerUsesHive(trigger: Trigger): boolean {
  if (trigger.enabled === false) return false;
  if (actionUsesHive(trigger.action)) return true;
  if (trigger.router) return true;
  return (trigger.context?.sources ?? []).some((source) => source.kind === "honeybee");
}

export type HiveProbe = { path: string | null; version: string | null; ok: boolean; error?: string };

export async function probeHive(bin: string | undefined, execution?: ExecutionProfile): Promise<HiveProbe> {
  const path = resolveHiveBin(bin, execution) ?? null;
  if (!path) return { path, version: null, ok: false, error: `${bin ?? DEFAULT_HIVE_BIN} not found on the execution PATH` };
  try {
    const result = await execArgv(path, ["--version", "--json"], { timeoutMs: HIVE_PROBE_TIMEOUT_MS, execution });
    if (result.timedOut) return { path, version: null, ok: false, error: `timed out after ${HIVE_PROBE_TIMEOUT_MS}ms` };
    const version = parseVersion(result.stdout);
    if (result.exitCode !== 0 || !version) {
      return { path, version, ok: false, error: firstLine(result.stderr) || firstLine(result.stdout) || `exited ${result.exitCode}` };
    }
    return { path, version, ok: true };
  } catch (error) {
    return { path, version: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseVersion(stdout: string): string | null {
  try {
    const version = (JSON.parse(stdout.trim()) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
