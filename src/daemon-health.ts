import { join } from "node:path";
import { readJsonOr, stateDir, writeJson } from "./fsx.js";
import type { RetentionConfig } from "./types.js";

export type DaemonRun = { pid: number; startedAt: string; stoppedAt?: string };
export type JobStoreHealth = {
  checkedAt: string;
  files: number;
  bytes: number;
  deleted: number;
  topTriggers: Array<{ triggerId: string; files: number }>;
  warnings: string[];
};

const RUN_HISTORY = 20;
const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
const CRASH_LOOP_EXITS = 3;

function runsPath(root: string): string {
  return join(stateDir(root), "daemon-runs.json");
}

function jobStoreHealthPath(root: string): string {
  return join(stateDir(root), "jobs-store.json");
}

export async function readDaemonRuns(root: string): Promise<DaemonRun[]> {
  const parsed = await readJsonOr<{ runs?: DaemonRun[] }>(runsPath(root), {});
  return Array.isArray(parsed.runs) ? parsed.runs : [];
}

export async function recordDaemonStart(root: string, pid = process.pid, now = new Date()): Promise<{ uncleanExits: number; crashLoop: boolean }> {
  const runs = [...(await readDaemonRuns(root)), { pid, startedAt: now.toISOString() }].slice(-RUN_HISTORY);
  await writeJson(runsPath(root), { runs });
  return crashLoopStatus(runs, pid, now);
}

export async function recordDaemonStop(root: string, pid = process.pid, now = new Date()): Promise<void> {
  const runs = await readDaemonRuns(root);
  const current = [...runs].reverse().find((run) => run.pid === pid && !run.stoppedAt);
  if (!current) return;
  current.stoppedAt = now.toISOString();
  await writeJson(runsPath(root), { runs });
}

export function crashLoopStatus(runs: DaemonRun[], livePid: number | undefined, now = new Date()): { uncleanExits: number; crashLoop: boolean; lastUncleanAt?: string } {
  const unclean = runs.filter((run) => !run.stoppedAt && run.pid !== livePid && now.getTime() - Date.parse(run.startedAt) < 60 * 60_000);
  const recent = unclean.filter((run) => now.getTime() - Date.parse(run.startedAt) < CRASH_LOOP_WINDOW_MS);
  return { uncleanExits: unclean.length, crashLoop: recent.length >= CRASH_LOOP_EXITS, lastUncleanAt: unclean.at(-1)?.startedAt };
}

export function jobStoreWarnings(files: number, bytes: number, retention: RetentionConfig, topTriggers: JobStoreHealth["topTriggers"]): string[] {
  const warnings: string[] = [];
  const mb = bytes / 1_048_576;
  const top = topTriggers[0] ? ` (largest: ${topTriggers[0].triggerId} with ${topTriggers[0].files})` : "";
  if (files >= retention.jobsWarnFiles) warnings.push(`jobs store holds ${files} files, warn limit ${retention.jobsWarnFiles}${top}`);
  if (mb >= retention.jobsWarnMb) warnings.push(`jobs store is ${Math.round(mb)} MB, warn limit ${retention.jobsWarnMb} MB${top}`);
  return warnings;
}

export function topTriggersByFiles(counts: Record<string, { files: number }>, limit = 5): JobStoreHealth["topTriggers"] {
  return Object.entries(counts)
    .map(([triggerId, bucket]) => ({ triggerId, files: bucket.files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, limit);
}

export async function writeJobStoreHealth(root: string, health: JobStoreHealth): Promise<void> {
  await writeJson(jobStoreHealthPath(root), health, { sync: false });
}

export async function readJobStoreHealth(root: string): Promise<JobStoreHealth | null> {
  return readJsonOr<JobStoreHealth | null>(jobStoreHealthPath(root), null);
}
