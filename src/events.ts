import { watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent, ledgerPath, previousLedgerPath, readJsonOr, readLedgerGeneration, stateDir, writeJson } from "./fsx.js";
import type { Trigger } from "./types.js";

export const DEFAULT_EVENTS_HEARTBEAT_MS = 15_000;
export const DEFAULT_EVENTS_POLL_MS = 1_000;
export const ROTATION_SETTLE_MS = 500;
const READ_CHUNK_BYTES = 64 * 1024;
const REMOVED_TRIGGER_MEMORY = 512;

export type LedgerPosition = { generation: number; offset: number };

export type EventsQuery = {
  after?: LedgerPosition;
  follow: boolean;
  trigger?: string;
  tag?: string;
  types?: Set<string>;
};

export class EventsRequestError extends Error {
  constructor(
    readonly code: "invalid_cursor" | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}

export function formatCursor(position: LedgerPosition): string {
  return `${position.generation}-${position.offset}`;
}

export function parseCursor(value: string): LedgerPosition {
  const match = /^(\d{1,15})-(\d{1,15})$/.exec(value);
  if (!match) throw new EventsRequestError("invalid_cursor", `Malformed cursor ${JSON.stringify(value)}; expected <generation>-<offset>`);
  return { generation: Number(match[1]), offset: Number(match[2]) };
}

export function parseEventsQuery(params: URLSearchParams): EventsQuery {
  const after = params.get("after");
  const types = params.get("types");
  const follow = params.get("follow");
  if (follow !== null && !["", "0", "1", "true", "false"].includes(follow)) {
    throw new EventsRequestError("invalid_request", `follow must be 1 or 0, got ${JSON.stringify(follow)}`);
  }
  const typeList = types
    ?.split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  return {
    after: after ? parseCursor(after) : undefined,
    follow: follow === "" || follow === "1" || follow === "true",
    trigger: params.get("trigger") || undefined,
    tag: params.get("tag") || undefined,
    types: typeList?.length ? new Set(typeList) : undefined,
  };
}

type TriggerTagsFile = { triggers?: Record<string, string[]>; removed?: Array<[string, string[]]> };

export class TriggerTagIndex {
  private live = new Map<string, string[]>();
  private removed = new Map<string, string[]>();
  private signature = "";

  constructor(
    private readonly path?: string,
    private readonly lookup?: (triggerId: string) => Promise<Pick<Trigger, "tags"> | null>,
  ) {}

  static forStore(root: string, lookup?: (triggerId: string) => Promise<Pick<Trigger, "tags"> | null>): TriggerTagIndex {
    return new TriggerTagIndex(join(stateDir(root), "trigger-tags.json"), lookup);
  }

  async load(): Promise<void> {
    if (!this.path) return;
    const saved = await readJsonOr<TriggerTagsFile>(this.path, {});
    this.live = new Map(Object.entries(saved.triggers ?? {}).filter((entry) => isTagList(entry[1])));
    this.removed = new Map((saved.removed ?? []).filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && isTagList(entry[1])));
    this.signature = this.currentSignature();
  }

  async observe(triggers: Trigger[]): Promise<void> {
    const next = new Map(triggers.map((trigger) => [trigger.id, [...trigger.tags]]));
    for (const [id, tags] of this.live) {
      if (next.has(id)) continue;
      this.removed.delete(id);
      this.removed.set(id, tags);
    }
    for (const id of next.keys()) this.removed.delete(id);
    while (this.removed.size > REMOVED_TRIGGER_MEMORY) this.removed.delete(this.removed.keys().next().value as string);
    this.live = next;
    const signature = this.currentSignature();
    if (signature === this.signature) return;
    this.signature = signature;
    if (this.path) await writeJson(this.path, { triggers: Object.fromEntries(this.live), removed: [...this.removed] } satisfies TriggerTagsFile);
  }

  async tagsOf(triggerId: string): Promise<string[] | undefined> {
    const known = this.live.get(triggerId) ?? this.removed.get(triggerId);
    if (known || !this.lookup) return known;
    const found = await this.lookup(triggerId).catch(() => null);
    if (!found) return undefined;
    this.live.set(triggerId, [...found.tags]);
    return found.tags;
  }

  private currentSignature(): string {
    return JSON.stringify([[...this.live], [...this.removed]]);
  }
}

function isTagList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string");
}

export type EventsStreamOptions = {
  root: string;
  query: EventsQuery;
  tags?: Pick<TriggerTagIndex, "tagsOf">;
  heartbeatMs?: number;
  pollMs?: number;
};

export type EventsSink = {
  write(line: string): Promise<void>;
  signal: AbortSignal;
};

export function eventsHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.POLLINATE_EVENTS_HEARTBEAT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_EVENTS_HEARTBEAT_MS;
}

export type EventsStream = { start: LedgerPosition; gap: boolean; run(sink: EventsSink): Promise<void> };

export async function openEventsStream(options: EventsStreamOptions): Promise<EventsStream> {
  const { root, query } = options;
  const start = query.after ? await resolveCursor(root, query.after) : { position: await currentEnd(root), gap: false };
  return {
    start: start.position,
    gap: start.gap,
    run: (sink) => runEventsStream(options, start.position, start.gap, sink),
  };
}

async function runEventsStream(options: EventsStreamOptions, start: LedgerPosition, startsWithGap: boolean, sink: EventsSink): Promise<void> {
  const { root, query } = options;
  const heartbeatMs = options.heartbeatMs ?? eventsHeartbeatMs();
  const pollMs = options.pollMs ?? DEFAULT_EVENTS_POLL_MS;
  const matches = eventFilter(query, options.tags);
  let position = start;
  const emit = async (value: Record<string, unknown>) => {
    if (!sink.signal.aborted) await sink.write(`${JSON.stringify(value)}\n`);
  };
  const heartbeat = () => emit({ heartbeat: true, cursor: formatCursor(position) });

  if (startsWithGap) await emit({ gap: true, cursor: formatCursor(position) });
  else if (!query.after) await heartbeat();

  const waker = new Waker(root, pollMs, sink.signal);
  let nextHeartbeatAt = Date.now() + heartbeatMs;
  try {
    for (;;) {
      if (sink.signal.aborted) return;
      position = await drain(root, position, sink.signal, async (event, cursor) => {
        if (await matches(event)) await emit({ ...event, cursor: formatCursor(cursor) });
      }, async (gapAt) => {
        await emit({ gap: true, cursor: formatCursor(gapAt) });
      });
      if (!query.follow) {
        if (query.after) await heartbeat();
        return;
      }
      if (Date.now() >= nextHeartbeatAt) {
        await heartbeat();
        nextHeartbeatAt = Date.now() + heartbeatMs;
      }
      await waker.wait(Math.max(0, nextHeartbeatAt - Date.now()));
    }
  } finally {
    waker.close();
  }
}

function eventFilter(query: EventsQuery, tags: EventsStreamOptions["tags"]): (event: Record<string, unknown>) => Promise<boolean> {
  return async (event) => {
    if (query.types && !query.types.has(String(event.event))) return false;
    const triggerId = typeof event.trigger_id === "string" ? event.trigger_id : undefined;
    if (query.trigger && triggerId !== query.trigger) return false;
    if (!query.tag) return true;
    if (!triggerId || !tags) return false;
    return (await tags.tagsOf(triggerId))?.includes(query.tag) ?? false;
  };
}

class Waker {
  private watcher?: FSWatcher;
  private pending?: () => void;
  private dirty = false;

  constructor(
    root: string,
    private readonly pollMs: number,
    private readonly signal: AbortSignal,
  ) {
    try {
      this.watcher = watch(root, { persistent: false }, (_type, filename) => {
        if (!filename || String(filename).startsWith("ledger.jsonl")) this.wake();
      });
      this.watcher.on("error", () => this.closeWatcher());
    } catch {
      this.watcher = undefined;
    }
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  async wait(maxMs: number): Promise<void> {
    if (!this.dirty && !this.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(maxMs, this.pollMs));
        this.pending = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    this.pending = undefined;
    this.dirty = false;
  }

  close(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    this.closeWatcher();
    this.pending?.();
  }

  private readonly onAbort = () => this.wake();

  private wake(): void {
    if (this.pending) this.pending();
    else this.dirty = true;
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}

type OpenedGeneration = { current: number; handle: FileHandle | null };

async function openGeneration(root: string, generation: number): Promise<OpenedGeneration> {
  for (;;) {
    const before = await readLedgerGeneration(root);
    const path = generation === before ? ledgerPath(root) : generation === before - 1 ? previousLedgerPath(root) : undefined;
    const handle = path ? await openIfExists(path) : null;
    const after = await readLedgerGeneration(root);
    if (before === after) return { current: before, handle };
    await handle?.close();
  }
}

async function openIfExists(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "r");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function oldestPosition(root: string, current: number): Promise<LedgerPosition> {
  if (current > 0 && (await stat(previousLedgerPath(root)).catch(() => undefined))) return { generation: current - 1, offset: 0 };
  return { generation: current, offset: 0 };
}

async function currentEnd(root: string): Promise<LedgerPosition> {
  for (;;) {
    const generation = await readLedgerGeneration(root);
    const { current, handle } = await openGeneration(root, generation);
    try {
      if (current !== generation) continue;
      if (!handle) return { generation, offset: 0 };
      const { size } = await handle.stat();
      return { generation, offset: await lastLineEnd(handle, size) };
    } finally {
      await handle?.close();
    }
  }
}

async function lastLineEnd(handle: FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const length = Math.min(READ_CHUNK_BYTES, end);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, end - length);
    const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (index >= 0) return end - length + index + 1;
    end -= length;
  }
  return 0;
}

async function resolveCursor(root: string, cursor: LedgerPosition): Promise<{ position: LedgerPosition; gap: boolean }> {
  const { current, handle } = await openGeneration(root, cursor.generation);
  try {
    if (cursor.generation > current) return { position: await oldestPosition(root, current), gap: true };
    if (!handle) {
      if (cursor.generation === current && cursor.offset === 0) return { position: cursor, gap: false };
      return { position: await oldestPosition(root, current), gap: true };
    }
    const { size } = await handle.stat();
    if (cursor.offset > size) return { position: await oldestPosition(root, current), gap: true };
    if (cursor.offset > 0) {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, cursor.offset - 1);
      if (byte[0] !== 0x0a) throw new EventsRequestError("invalid_cursor", `Cursor ${formatCursor(cursor)} does not point at the end of a ledger line`);
    }
    return { position: cursor, gap: false };
  } finally {
    await handle?.close();
  }
}

type LineHandler = (event: Record<string, unknown>, cursor: LedgerPosition) => Promise<void>;

async function drain(root: string, from: LedgerPosition, signal: AbortSignal, onEvent: LineHandler, onGap: (at: LedgerPosition) => Promise<void>): Promise<LedgerPosition> {
  let position = from;
  for (;;) {
    if (signal.aborted) return position;
    const { current, handle } = await openGeneration(root, position.generation);
    try {
      if (position.generation > current || position.generation < current - 1) {
        position = await oldestPosition(root, current);
        await onGap(position);
        continue;
      }
      if (!handle) {
        if (position.generation === current) return position;
        position = { generation: current, offset: 0 };
        continue;
      }
      const { size, mtimeMs } = await handle.stat();
      if (position.offset > size) {
        position = await oldestPosition(root, current);
        await onGap(position);
        continue;
      }
      position = await readLines(handle, position, signal, onEvent);
      if (position.generation < current) {
        const settleFor = ROTATION_SETTLE_MS - (Date.now() - mtimeMs);
        if (settleFor > 0) {
          await new Promise((resolve) => setTimeout(resolve, settleFor));
          position = await readLines(handle, position, signal, onEvent);
        }
      }
      if (position.generation === current || signal.aborted) return position;
      position = { generation: current, offset: 0 };
    } finally {
      await handle?.close();
    }
  }
}

async function readLines(handle: FileHandle, from: LedgerPosition, signal: AbortSignal, onEvent: LineHandler): Promise<LedgerPosition> {
  let offset = from.offset;
  let pending = Buffer.alloc(0);
  let readAt = offset;
  for (;;) {
    if (signal.aborted) break;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, readAt);
    if (bytesRead === 0) break;
    readAt += bytesRead;
    pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let lineStart = 0;
    for (let newline = pending.indexOf(0x0a); newline >= 0; newline = pending.indexOf(0x0a, lineStart)) {
      const line = pending.subarray(lineStart, newline).toString("utf8");
      offset += newline + 1 - lineStart;
      lineStart = newline + 1;
      const event = parseLedgerLine(line);
      if (event) await onEvent(event, { generation: from.generation, offset });
      if (signal.aborted) return { generation: from.generation, offset };
    }
    pending = pending.subarray(lineStart);
  }
  return { generation: from.generation, offset };
}

function parseLedgerLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL, options: Omit<EventsStreamOptions, "query">): Promise<void> {
  const stream = await openEventsStream({ ...options, query: parseEventsQuery(url.searchParams) });
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("close", abort);
  res.once("close", abort);
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.flushHeaders();
  try {
    await stream.run({
      signal: controller.signal,
      write: (line) => writeWithBackpressure(res, line, controller.signal),
    });
  } finally {
    req.off("close", abort);
    res.off("close", abort);
    if (!res.writableEnded) res.end();
  }
}

function writeWithBackpressure(res: ServerResponse, line: string, signal: AbortSignal): Promise<void> {
  if (res.write(line)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
}
