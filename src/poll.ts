import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Activation, CursorState, ExecutionProfile, JsonValue, PollSpec, Trigger } from "./types.js";
import { DeliveryManager, deliveryIdFor } from "./delivery.js";
import type { HealthRecorder } from "./health.js";
import { PollinateStore } from "./store.js";
import { execShell } from "./process.js";
import { selectJsonPathArray } from "./jsonpath.js";
import { nowIso, parseDuration, stableStringify } from "./time.js";

export const POLL_BACKOFF_AFTER_ERRORS = 2;
export const POLL_BACKOFF_MAX_DOUBLINGS = 16;

export function pollDelayMs(intervalMs: number, consecutiveErrors: number): number {
  const doublings = Math.min(Math.max(0, consecutiveErrors - POLL_BACKOFF_AFTER_ERRORS), POLL_BACKOFF_MAX_DOUBLINGS);
  return intervalMs * 2 ** doublings;
}

export type PollCheck = { baselined: boolean; itemCount: number; newCount: number };

export class PollEngine {
  private cursors: CursorState = {};
  private timers = new Map<string, NodeJS.Timeout>();
  private polling = new Map<string, Promise<PollCheck>>();
  private errors = new Map<string, number>();
  private cursorWrite: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly store: PollinateStore,
    private readonly delivery: DeliveryManager,
    private triggers: Trigger[],
    private readonly execution?: ExecutionProfile,
    private readonly health?: HealthRecorder,
  ) {}

  async start(): Promise<void> {
    this.cursors = await this.store.readCursorState();
    this.running = true;
    this.reconcileTimers();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.writeCursors();
  }

  updateTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
    if (this.forgetRemovedTriggers()) void this.writeCursors().catch(() => undefined);
    this.reconcileTimers();
  }

  private forgetRemovedTriggers(): boolean {
    const known = new Set(this.triggers.map((trigger) => trigger.id));
    let dirty = false;
    for (const triggerId of Object.keys(this.cursors)) {
      if (known.has(triggerId)) continue;
      delete this.cursors[triggerId];
      dirty = true;
    }
    return dirty;
  }

  async pollNow(trigger: Trigger): Promise<number> {
    if (trigger.source.kind !== "poll") throw new Error(`Trigger ${trigger.id} is not a poll trigger`);
    const inFlight = this.polling.get(trigger.id);
    if (inFlight) return (await inFlight).newCount;
    return (await this.track(trigger.id, this.runPollNow(trigger))).newCount;
  }

  async preflight(trigger: Trigger): Promise<string> {
    if (trigger.source.kind !== "poll") throw new Error(`Trigger ${trigger.id} is not a poll trigger`);
    const fetched = await fetchPoll(trigger.source.poll, trigger.cwd, this.execution);
    detectDelta(trigger.source.poll, trigger.id, fetched, {});
    return fetched;
  }

  async adoptChecked(triggers: Trigger[], trigger: Trigger, fetched: string): Promise<PollCheck> {
    const existing = this.timers.get(trigger.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(trigger.id);
    const previous = this.polling.get(trigger.id);
    const run = this.track(
      trigger.id,
      (previous ?? Promise.resolve()).catch(() => undefined).then(() => this.applyFetched(trigger, fetched)),
    );
    this.updateTriggers(triggers);
    try {
      const check = await run;
      this.errors.delete(trigger.id);
      await this.health?.recordSuccess(trigger.id, "poll");
      return check;
    } finally {
      const latest = this.pollTriggers().find((item) => item.id === trigger.id);
      if (latest && !this.polling.has(latest.id)) this.schedule(latest, this.nextDelayMs(latest));
    }
  }

  private track(triggerId: string, polling: Promise<PollCheck>): Promise<PollCheck> {
    const tracked = polling.finally(() => {
      if (this.polling.get(triggerId) === tracked) this.polling.delete(triggerId);
    });
    this.polling.set(triggerId, tracked);
    return tracked;
  }

  private async runPollNow(trigger: Trigger): Promise<PollCheck> {
    if (trigger.source.kind !== "poll") throw new Error(`Trigger ${trigger.id} is not a poll trigger`);
    return this.applyFetched(trigger, await fetchPoll(trigger.source.poll, trigger.cwd, this.execution));
  }

  private async applyFetched(trigger: Trigger, fetched: string): Promise<PollCheck> {
    if (trigger.source.kind !== "poll") throw new Error(`Trigger ${trigger.id} is not a poll trigger`);
    const spec = trigger.source.poll;
    const firstCheck = this.cursors[trigger.id] === undefined;
    const delta = detectDelta(spec, trigger.id, fetched, this.cursors);
    if (spec.baseline && firstCheck) {
      this.cursors[trigger.id] = delta.cursors[trigger.id];
      await this.writeCursors();
      await this.store.appendLedger({ event: "pollinate.poll.baselined", trigger_id: trigger.id, item_count: delta.itemCount, at: nowIso() });
      return { baselined: true, itemCount: delta.itemCount, newCount: 0 };
    }
    await this.store.appendLedger({
      event: "pollinate.poll.checked",
      trigger_id: trigger.id,
      item_count: delta.itemCount,
      new_count: delta.items.length,
      at: nowIso(),
    });
    this.cursors[trigger.id] = delta.cursors[trigger.id];
    await this.writeCursors();
    if (delta.items.length > 0) {
      const checkedAt = nowIso();
      if (spec.emit === "per-item") {
        for (const [index, item] of delta.items.entries()) {
          await this.dispatch(trigger, item, `poll:${checkedAt}:${index}`);
        }
      } else {
        await this.dispatch(trigger, delta.items as JsonValue, `poll:${checkedAt}:0`);
      }
      await this.store.appendLedger({ event: "pollinate.poll.detected", trigger_id: trigger.id, item_count: delta.items.length, at: nowIso() });
    }
    return { baselined: false, itemCount: delta.itemCount, newCount: delta.items.length };
  }

  private schedule(trigger: Trigger, delayMs: number): void {
    if (!this.running) return;
    const existing = this.timers.get(trigger.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.timers.delete(trigger.id);
      try {
        const latest = this.pollTriggers().find((item) => item.id === trigger.id);
        if (latest) {
          await this.pollNow(latest);
          this.errors.delete(latest.id);
          await this.health?.recordSuccess(latest.id, "poll");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const consecutive = (this.errors.get(trigger.id) ?? 0) + 1;
        this.errors.set(trigger.id, consecutive);
        await this.store.appendLedger({
          event: "pollinate.poll.errored",
          trigger_id: trigger.id,
          error: message,
          consecutive_errors: consecutive,
          next_check_in_ms: this.nextDelayMs(trigger),
        });
        await this.health?.recordFailure(trigger.id, { kind: "poll", error: message });
      } finally {
        const latest = this.pollTriggers().find((item) => item.id === trigger.id);
        if (latest && latest.source.kind === "poll") this.schedule(latest, this.nextDelayMs(latest));
      }
    }, delayMs);
    this.timers.set(trigger.id, timer);
  }

  private reconcileTimers(): void {
    if (!this.running) return;
    const active = new Map(this.pollTriggers().map((trigger) => [trigger.id, trigger]));
    for (const [triggerId, timer] of this.timers.entries()) {
      if (!active.has(triggerId)) {
        clearTimeout(timer);
        this.timers.delete(triggerId);
        this.errors.delete(triggerId);
      }
    }
    for (const trigger of active.values()) {
      if (!this.timers.has(trigger.id) && !this.polling.has(trigger.id)) this.schedule(trigger, 0);
    }
  }

  private nextDelayMs(trigger: Trigger): number {
    if (trigger.source.kind !== "poll") return 0;
    return pollDelayMs(parseDuration(trigger.source.poll.interval), this.errors.get(trigger.id) ?? 0);
  }

  private async writeCursors(): Promise<void> {
    const write = this.cursorWrite.then(() => this.store.writeCursorState(this.cursors));
    this.cursorWrite = write.catch(() => undefined);
    await write;
  }

  private async dispatch(trigger: Trigger, payload: JsonValue, deliveryPart: string): Promise<void> {
    const activation: Activation = {
      triggerId: trigger.id,
      source: "poll",
      payload,
      receivedAt: nowIso(),
      metadata: { deliveryId: deliveryIdFor(trigger.id, deliveryPart) },
    };
    await this.delivery.handle(trigger, activation);
  }

  private pollTriggers(): Trigger[] {
    return this.triggers.filter((trigger) => trigger.enabled && trigger.source.kind === "poll");
  }
}

export async function fetchPoll(spec: PollSpec, cwd?: string, execution?: ExecutionProfile): Promise<string> {
  if (spec.fetch.kind === "file") return readFile(spec.fetch.path, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return "";
    throw error;
  });
  if (spec.fetch.kind === "command") {
    const timeoutMs = parseDuration(spec.interval);
    const result = await execShell(spec.fetch.command, { cwd: spec.fetch.cwd ?? cwd, execution, timeoutMs });
    if (result.timedOut) throw new Error(`poll command timed out after ${timeoutMs}ms`);
    if (result.exitCode !== 0) throw new Error(`poll command exited ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout;
  }
  const timeoutMs = parseDuration(spec.interval);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(spec.fetch.url, { method: spec.fetch.method ?? "GET", headers: spec.fetch.headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`poll HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text;
  } catch (error) {
    if (isAbortError(error)) throw new Error(`poll HTTP timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
}

export function detectDelta(
  spec: PollSpec,
  triggerId: string,
  fetched: string,
  cursors: CursorState,
): { items: JsonValue[]; cursors: CursorState; itemCount: number } {
  const next = { ...cursors };
  const key = triggerId;
  if (spec.cursor.strategy === "append-offset") {
    const previous = typeof cursors[key] === "number" ? cursors[key] : 0;
    const current = fetched.length;
    const itemCount = parseLines(fetched).length;
    next[key] = current;
    if (current <= previous) return { items: [], cursors: next, itemCount };
    const delta = fetched.slice(previous);
    return { items: parseLines(delta), cursors: next, itemCount };
  }
  if (spec.cursor.strategy === "hash") {
    const previous = new Set(Array.isArray(cursors[key]) ? (cursors[key] as JsonValue[]).map(String) : []);
    const items = parsePollItems(fetched);
    const newItems: JsonValue[] = [];
    const hashes: string[] = [];
    for (const item of items) {
      const hash = hashValue(item);
      hashes.push(hash);
      if (!previous.has(hash)) newItems.push(item);
    }
    next[key] = hashes;
    return { items: newItems, cursors: next, itemCount: items.length };
  }
  const json = JSON.parse(fetched || "null");
  const selected = selectJsonPathArray(spec.cursor.jsonpath, json);
  const previous = new Set(Array.isArray(cursors[key]) ? (cursors[key] as JsonValue[]).map(String) : []);
  const ids = selected.map((item) => String(item));
  next[key] = ids;
  return {
    items: selected.filter((item) => !previous.has(String(item))).map(toJsonValue),
    cursors: next,
    itemCount: selected.length,
  };
}

function parsePollItems(text: string): JsonValue[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map(toJsonValue);
    return [toJsonValue(parsed)];
  } catch {
    return parseLines(text);
  }
}

function parseLines(text: string): JsonValue[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return toJsonValue(JSON.parse(line));
      } catch {
        return line;
      }
    });
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    typeof value === "object"
  ) {
    return value as JsonValue;
  }
  return String(value);
}

function hashValue(value: JsonValue): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
