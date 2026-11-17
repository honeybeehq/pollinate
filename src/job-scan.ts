import { opendir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job, JobStatus } from "./types.js";

export type JobSummary = {
  file: string;
  id: string;
  uuid?: string;
  triggerId: string;
  status: JobStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  bytes: number;
};

const SUMMARY_KEYS = ["id", "idPrefix", "uuid", "triggerId", "source", "status", "queuedAt", "startedAt", "completedAt"] as const;
const SUMMARY_KEY_SET = new Set<string>(SUMMARY_KEYS);
const HEAD_BYTES = 4096;
const SCAN_CONCURRENCY = 16;
const TOP_LEVEL_STRING_FIELD = /^ {2}"([A-Za-z]+)": ("(?:[^"\\]|\\.)*"),?$/;
const TOP_LEVEL_SUMMARY_NEEDLES = ["id", "uuid", "triggerId", "status", "queuedAt", "startedAt", "completedAt"].map(
  (key) => [key, Buffer.from(`\n  "${key}": "`)] as const,
);

export function orderJobForWrite(job: Job): Job {
  const ordered: Record<string, unknown> = {};
  const source = job as unknown as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) if (source[key] !== undefined) ordered[key] = source[key];
  for (const [key, value] of Object.entries(source)) if (!SUMMARY_KEY_SET.has(key)) ordered[key] = value;
  return ordered as unknown as Job;
}

export async function* jobFileNames(dir: string): AsyncGenerator<string> {
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(dir, { bufferSize: 256 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of handle) {
    if (entry.name.endsWith(".json") && !entry.isDirectory()) yield entry.name;
  }
}

export async function* scanJobSummaries(dir: string, concurrency = SCAN_CONCURRENCY): AsyncGenerator<JobSummary> {
  const pending = new Map<number, Promise<{ key: number; summary: JobSummary | null }>>();
  let next = 0;
  for await (const file of jobFileNames(dir)) {
    const key = next++;
    pending.set(key, readJobSummary(join(dir, file), file).then((summary) => ({ key, summary })));
    if (pending.size < concurrency) continue;
    const done = await Promise.race(pending.values());
    pending.delete(done.key);
    if (done.summary) yield done.summary;
  }
  while (pending.size > 0) {
    const done = await Promise.race(pending.values());
    pending.delete(done.key);
    if (done.summary) yield done.summary;
  }
}

export async function readJobSummary(path: string, file: string): Promise<JobSummary | null> {
  let head: string;
  let bytes: number;
  try {
    const handle = await open(path, "r");
    try {
      bytes = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  try {
    const fromHead = bytes > HEAD_BYTES ? summaryFromHead(head, file, bytes) : null;
    if (fromHead) return fromHead;
    const buffer = bytes > HEAD_BYTES ? await readFile(path) : Buffer.from(head);
    return summaryFromTopLevelKeys(buffer, file, bytes) ?? summaryFromJob(JSON.parse(buffer.toString("utf8")) as Job, file, bytes);
  } catch {
    return null;
  }
}

function summaryFromTopLevelKeys(buffer: Buffer, file: string, bytes: number): JobSummary | null {
  if (buffer[0] !== 0x7b || buffer[1] !== 0x0a) return null;
  const fields: Record<string, string> = {};
  for (const [key, needle] of TOP_LEVEL_SUMMARY_NEEDLES) {
    const at = buffer.indexOf(needle);
    if (at < 0) continue;
    const start = at + needle.length - 1;
    const lineEnd = buffer.indexOf(0x0a, start);
    let raw = buffer.toString("utf8", start, lineEnd < 0 ? buffer.length : lineEnd);
    if (raw.endsWith(",")) raw = raw.slice(0, -1);
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string") fields[key] = value;
  }
  return summaryFromFields(fields, file, bytes);
}

function summaryFromHead(head: string, file: string, bytes: number): JobSummary | null {
  const lines = head.split("\n");
  if (lines[0] !== "{") return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const match = TOP_LEVEL_STRING_FIELD.exec(line);
    const key = match?.[1] ?? /^ {2}"([A-Za-z]+)":/.exec(line)?.[1];
    if (!key) return null;
    if (!SUMMARY_KEY_SET.has(key)) return summaryFromFields(fields, file, bytes);
    if (!match) return null;
    const value: unknown = JSON.parse(match[2]);
    if (typeof value !== "string") return null;
    fields[key] = value;
  }
  return null;
}

function summaryFromFields(fields: Record<string, string>, file: string, bytes: number): JobSummary | null {
  if (!fields.id || !fields.triggerId || !fields.status || !fields.queuedAt) return null;
  return {
    file,
    id: fields.id,
    uuid: fields.uuid,
    triggerId: fields.triggerId,
    status: fields.status as JobStatus,
    queuedAt: fields.queuedAt,
    startedAt: fields.startedAt,
    completedAt: fields.completedAt,
    bytes,
  };
}

function summaryFromJob(job: Job, file: string, bytes: number): JobSummary | null {
  if (!job || typeof job !== "object" || typeof job.id !== "string") return null;
  return {
    file,
    id: job.id,
    uuid: job.uuid,
    triggerId: job.triggerId,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    bytes,
  };
}

export function insertNewestFirst<T>(list: T[], item: T, key: (value: T) => string, limit: number): T | undefined {
  const value = key(item);
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key(list[mid]) >= value) low = mid + 1;
    else high = mid;
  }
  if (limit > 0 && low >= limit) return item;
  list.splice(low, 0, item);
  return limit > 0 && list.length > limit ? list.pop() : undefined;
}
