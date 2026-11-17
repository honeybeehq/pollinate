import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, jobsDir, readJsonOr, stateDir, withFileLock } from "./fsx.js";
import { scanJobSummaries } from "./job-scan.js";
import type { Job, Trigger } from "./types.js";

export type JobIdentity = {
  id: string;
  idPrefix: string;
  uuid: string;
};

type JobIdIndex = {
  used: string[];
};

type ReadJobIdIndex = JobIdIndex & {
  repairFromJobs: boolean;
};

export type AllocateJobIdentityOptions = {
  root: string;
  trigger: Trigger;
  uuid?: () => string;
};

export const MIN_JOB_ID_CHARS = 3;

export async function allocateJobIdentity(options: AllocateJobIdentityOptions): Promise<JobIdentity> {
  return withFileLock(jobIdIndexLockPath(options.root), async () => {
    const indexed = await readJobIdIndex(options.root);
    const used = indexed.repairFromJobs ? await mergeCurrentJobUuids(options.root, indexed.used) : indexed.used;
    const uuidFactory = options.uuid ?? randomUUID;
    const idPrefix = jobPrefixForTrigger(options.trigger);

    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const uuid = normalizeJobUuid(uuidFactory());
      const position = insertionIndex(used, uuid);
      if (used[position] === uuid) continue;

      const length = minimumUniqueNormalizedUuidPrefixLength(uuid, used, position);
      const id = `${idPrefix}${uuid.slice(0, length)}`;
      if (await jobFileExists(options.root, id)) continue;
      used.splice(position, 0, uuid);
      await writeJobIdIndex(options.root, { used });
      return { id, idPrefix, uuid };
    }

    throw new Error("Could not allocate a unique job id after 100000 UUID attempts");
  });
}

export async function readJobIdIndexSnapshot(root: string): Promise<Set<string>> {
  return withFileLock(jobIdIndexLockPath(root), async () => new Set((await readJobIdIndex(root)).used));
}

export async function reconcileJobIdIndex(root: string, snapshot: ReadonlySet<string>, live: ReadonlySet<string>): Promise<number> {
  if (snapshot.size === 0) return 0;
  return withFileLock(jobIdIndexLockPath(root), async () => {
    const indexed = await readJobIdIndex(root);
    if (indexed.repairFromJobs) return 0;
    const next = indexed.used.filter((uuid) => live.has(uuid) || !snapshot.has(uuid));
    if (next.length === indexed.used.length) return 0;
    await writeJobIdIndex(root, { used: next });
    return indexed.used.length - next.length;
  });
}

export function jobUuidsOf(job: { file?: string; uuid?: string }): string[] {
  const uuids: string[] = [];
  const fileUuid = job.file ? maybeNormalizeJobUuid(job.file.replace(/\.json$/, "")) : undefined;
  if (fileUuid) uuids.push(fileUuid);
  const jobUuid = maybeNormalizeJobUuid(job.uuid);
  if (jobUuid) uuids.push(jobUuid);
  return uuids;
}

async function jobFileExists(root: string, id: string): Promise<boolean> {
  return access(join(jobsDir(root), `${id}.json`)).then(
    () => true,
    () => false,
  );
}

export function jobPrefixForTrigger(trigger: Pick<Trigger, "id" | "name" | "source">): string {
  const seed = trigger.id || trigger.name || trigger.source.kind || "job";
  const cleaned = seed.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return `${(cleaned || "JO").slice(0, 2).padEnd(2, "X")}.`;
}

export function minimumUniqueUuidPrefixLength(uuidValue: string, sortedUsedValues: readonly string[], knownInsertionIndex?: number): number {
  const uuid = normalizeJobUuid(uuidValue);
  const sortedUsed = sortedUsedValues.map(normalizeJobUuid);
  const position = knownInsertionIndex ?? insertionIndex(sortedUsed, uuid);
  return minimumUniqueNormalizedUuidPrefixLength(uuid, sortedUsed, position);
}

function minimumUniqueNormalizedUuidPrefixLength(uuid: string, sortedUsed: readonly string[], position: number): number {
  // In a sorted set, the nearest lexicographic neighbors have the longest possible
  // common prefix with a new UUID, so they are sufficient to find the shortest
  // globally unused prefix.
  const previous = position > 0 ? sortedUsed[position - 1] : undefined;
  const next = sortedUsed[position];
  const shared = Math.max(previous ? commonPrefixLength(uuid, previous) : 0, next ? commonPrefixLength(uuid, next) : 0);
  return Math.min(uuid.length, Math.max(MIN_JOB_ID_CHARS, shared + 1));
}

export function matchesJobReference(job: Pick<Job, "id" | "uuid">, reference: string): boolean {
  const query = reference.trim();
  if (!query) return false;
  if (job.id === query) return true;

  const full = fullJobReference(job);
  if (full?.startsWith(query) && query.length >= job.id.length) return true;

  const suffix = suffixReference(job);
  if (suffix?.full.startsWith(query) && query.length >= suffix.display.length) return true;

  return !job.uuid && query.length >= MIN_JOB_ID_CHARS && job.id.startsWith(query);
}

export function fullJobReference(job: Pick<Job, "id" | "uuid">): string | undefined {
  if (!job.uuid) return job.id;
  const uuid = maybeNormalizeJobUuid(job.uuid);
  if (!uuid) return job.id;
  const dot = job.id.indexOf(".");
  const prefix = dot >= 0 ? job.id.slice(0, dot + 1) : "";
  return `${prefix}${uuid}`;
}

export function normalizeJobUuid(value: string): string {
  const normalized = value.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error(`Invalid UUID: ${value}`);
  return normalized;
}

function maybeNormalizeJobUuid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeJobUuid(value);
  } catch {
    return undefined;
  }
}

function suffixReference(job: Pick<Job, "id" | "uuid">): { display: string; full: string } | undefined {
  const dot = job.id.indexOf(".");
  const display = dot >= 0 ? job.id.slice(dot + 1) : job.id;
  if (!display) return undefined;
  const uuid = maybeNormalizeJobUuid(job.uuid);
  return { display, full: uuid ?? display };
}

async function mergeCurrentJobUuids(root: string, indexed: string[]): Promise<string[]> {
  const used = new Set(indexed.map(normalizeJobUuid));
  for await (const summary of scanJobSummaries(jobsDir(root))) for (const uuid of jobUuidsOf(summary)) used.add(uuid);
  return [...used].sort();
}

async function readJobIdIndex(root: string): Promise<ReadJobIdIndex> {
  const parsed = await readJsonOr<unknown | undefined>(jobIdIndexPath(root), undefined);
  if (parsed === undefined) return { used: [], repairFromJobs: true };
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return {
    used: Array.isArray(object.used) ? normalizeKnownJobUuids(object.used).sort() : [],
    repairFromJobs: false,
  };
}

async function writeJobIdIndex(root: string, index: JobIdIndex): Promise<void> {
  await atomicWriteFile(jobIdIndexPath(root), `${JSON.stringify({ used: index.used })}\n`, { mode: 0o600 });
}

function jobIdIndexPath(root: string): string {
  return join(stateDir(root), "job-id-index.json");
}

function jobIdIndexLockPath(root: string): string {
  return join(stateDir(root), "job-id-index.lock");
}

function normalizeKnownJobUuids(values: unknown[]): string[] {
  const used = new Set<string>();
  for (const value of values) {
    const uuid = maybeNormalizeJobUuid(String(value));
    if (uuid) used.add(uuid);
  }
  return [...used];
}

function insertionIndex(sorted: readonly string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}
