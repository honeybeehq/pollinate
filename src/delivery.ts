import { createHash, randomUUID } from "node:crypto";
import type { Activation, DeliveryEntry, DeliveryState, Job, JobStatus, JsonValue, SourceKind, Trigger } from "./types.js";
import { ActionExecutor, retryPolicyFor } from "./actions.js";
import { matchesFilter } from "./filter.js";
import { PollinateStore } from "./store.js";
import { nowIso, parseDuration } from "./time.js";
import { appendTextLine, daemonLogPath } from "./fsx.js";

const DEBOUNCE_MAX_WAIT_MULTIPLIER = 6;

export function deliveryIdFor(triggerId: string, part: string): string {
  return `${triggerId}:${part}`;
}

export function fallbackDeliveryPart(source: SourceKind, activation: Pick<Activation, "payload" | "receivedAt">): string {
  if (source === "schedule") {
    const payload = activation.payload;
    const scheduledAt = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.scheduled_at : undefined;
    return `sched:${typeof scheduledAt === "string" ? scheduledAt : activation.receivedAt}`;
  }
  if (source === "webhook") return `wh:${randomUUID()}`;
  if (source === "poll") return `poll:${activation.receivedAt}:0`;
  return `manual:${randomUUID()}`;
}

export function withDeliveryId(activation: Activation): Activation {
  if (activation.metadata?.deliveryId) return activation;
  return {
    ...activation,
    metadata: {
      ...activation.metadata,
      deliveryId: deliveryIdFor(activation.triggerId, fallbackDeliveryPart(activation.source, activation)),
      stableDeliveryId: activation.source === "schedule",
    },
  };
}

export function batchDeliveryId(triggerId: string, memberIds: string[]): string {
  const digest = createHash("sha256").update(memberIds.join("\n")).digest("hex").slice(0, 16);
  return deliveryIdFor(triggerId, `batch:${digest}`);
}

export function activationDeliveryIds(activation: Activation): string[] {
  const ids = activation.metadata?.deliveryIds;
  if (ids?.length) return ids;
  const id = activation.metadata?.deliveryId;
  return id ? [id] : [];
}

export async function admitDelivery(store: PollinateStore, activation: Activation): Promise<boolean> {
  const deliveryId = activation.metadata?.deliveryId;
  if (!deliveryId || !activation.metadata?.stableDeliveryId) return true;
  if (await store.claimDelivery(activation.triggerId, deliveryId)) return true;
  await store.appendLedger({ event: "pollinate.delivery.duplicate", trigger_id: activation.triggerId, delivery_id: deliveryId, source: activation.source });
  return false;
}

export type HandleOptions = { claimed?: boolean; admitted?: boolean };

export const DEFAULT_MAX_QUEUED = 1_000;
const TRIGGER_REMOVED = "trigger-removed";
const RESUMABLE_INTERRUPTED_STATUSES: readonly JobStatus[] = ["resolving-context", "running"];

type QueuedEntry = DeliveryEntry & { trigger: Trigger };

type RuntimeState = {
  running: number;
  queue: QueuedEntry[];
  inFlight: Map<string, DeliveryEntry>;
  timer?: NodeJS.Timeout;
};

type PersistedTriggerState = NonNullable<DeliveryState[string]>;

export class DeliveryManager {
  private persisted: DeliveryState = {};
  private runtime = new Map<string, RuntimeState>();
  private triggers = new Map<string, Trigger>();
  private restored = false;
  private stopping = false;
  private readonly inFlight = new Set<string>();
  private readonly retryWaits = new Map<string, { timer: NodeJS.Timeout; wake: () => void }>();
  private readonly flushChains = new Map<string, Promise<unknown>>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PollinateStore,
    private readonly executor: ActionExecutor,
  ) {}

  async init(triggers: Trigger[]): Promise<void> {
    this.triggers = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    if (!this.restored) this.persisted = await this.store.readDeliveryState();
    const orphaned = this.orphanedTriggerIds();
    for (const triggerId of orphaned) await this.cancelPendingJobs(triggerId);
    if (this.pruneOrphanedState(orphaned)) await this.persist();
    if (!this.restored) {
      this.restored = true;
      await this.restore();
    }
    for (const trigger of triggers) if (!keepsJobs(trigger) && this.hasPendingJobs(trigger.id)) await this.cancelPendingJobs(trigger.id);
  }

  async admit(trigger: Trigger, incoming: Activation, options: { preclaimed?: boolean } = {}): Promise<Activation | null> {
    const activation = withDeliveryId(incoming);
    const deliveryId = activation.metadata?.deliveryId;
    if (!deliveryId) return activation;
    const state = this.persistedFor(trigger.id);
    if (state.admitting?.[deliveryId]) return null;
    const claim = Boolean(activation.metadata?.stableDeliveryId) && !options.preclaimed;
    const claimedAt = claim ? Date.now() : undefined;
    state.admitting = { ...state.admitting, [deliveryId]: { activation, ...(claimedAt === undefined ? {} : { claimedAt }), ...(options.preclaimed ? { preclaimed: true } : {}) } };
    await this.persist();
    if (claim && !(await this.store.claimDelivery(trigger.id, deliveryId, claimedAt))) {
      this.settleAdmission(trigger.id, deliveryId);
      await this.persist();
      return null;
    }
    return activation;
  }

  async handle(trigger: Trigger, incoming: Activation, options: HandleOptions = {}): Promise<Job | null> {
    if (!trigger.enabled) return null;
    let activation = withDeliveryId(incoming);
    if (!options.admitted) {
      const admitted = await this.admit(trigger, activation, { preclaimed: options.claimed });
      if (!admitted) {
        await this.store.appendLedger({ event: "pollinate.delivery.duplicate", trigger_id: activation.triggerId, delivery_id: activation.metadata?.deliveryId, source: activation.source });
        return null;
      }
      activation = admitted;
    }
    const deliveryId = activation.metadata?.deliveryId ?? "";
    if (!matchesFilter(trigger.filter, activation.payload)) {
      this.settleAdmission(trigger.id, deliveryId);
      await this.persist();
      await this.store.appendLedger({ event: "pollinate.delivery.filtered", trigger_id: trigger.id });
      return null;
    }
    this.triggers.set(trigger.id, trigger);
    const mode = trigger.delivery.mode;
    if (mode.strategy === "immediate") return this.enqueue(trigger, activation, [activation.payload], () => this.settleAdmission(trigger.id, deliveryId));
    if (mode.strategy === "throttled") return this.handleThrottled(trigger, activation, deliveryId);
    if (mode.strategy === "batched") return this.handleBatched(trigger, activation, deliveryId);
    if (mode.strategy === "debounced") return this.handleDebounced(trigger, activation, deliveryId);
    const neverMode: never = mode;
    throw new Error(`Unsupported delivery mode: ${JSON.stringify(neverMode)}`);
  }

  ownsJob(jobId: string): boolean {
    if (this.inFlight.has(jobId)) return true;
    for (const runtime of this.runtime.values()) if (runtime.queue.some((item) => item.job.id === jobId)) return true;
    return false;
  }

  async adoptOrphan(job: Job): Promise<boolean> {
    if (this.ownsJob(job.id)) return true;
    const trigger = this.triggers.get(job.triggerId);
    if (!trigger || !keepsJobs(trigger) || !trigger.action) return false;
    if (job.status !== "retrying" && !(retryPolicyFor(trigger) && RESUMABLE_INTERRUPTED_STATUSES.includes(job.status))) return false;
    const batch = job.batch ?? [];
    const entry: DeliveryEntry = {
      job: { ...job, action: trigger.action, cwd: trigger.cwd },
      activation: {
        triggerId: trigger.id,
        source: job.source,
        payload: batch.length ? batch[batch.length - 1]! : {},
        receivedAt: job.queuedAt,
        metadata: job.deliveryId ? { deliveryId: job.deliveryId } : undefined,
      },
      batch,
    };
    this.startResumed(trigger, entry, job);
    await this.saveQueue(trigger.id);
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const state of this.runtime.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    for (const wait of this.retryWaits.values()) clearTimeout(wait.timer);
    this.retryWaits.clear();
    await this.persist();
  }

  private async restore(): Promise<void> {
    const now = Date.now();
    for (const [triggerId, state] of Object.entries(this.persisted)) {
      const trigger = this.triggers.get(triggerId);
      if (!trigger || !state) continue;
      const runtime = this.runtimeFor(trigger.id);
      for (const entry of state.inFlight ?? []) await this.restoreInFlight(trigger, entry);
      for (const queued of state.queue ?? []) {
        runtime.queue.push({ ...queued, trigger });
      }
      await this.restoreAdmitting(trigger, state);
      if (state.pendingBatch?.length && state.timerDueAt && state.timerKind) {
        const delay = this.pendingTimerDelayMs(trigger, state, now);
        runtime.timer = setTimeout(() => {
          this.runFlushPending(trigger);
        }, delay);
      }
      await this.saveQueue(trigger.id);
      this.runDrain(trigger);
    }
  }

  private async restoreInFlight(trigger: Trigger, entry: DeliveryEntry): Promise<void> {
    const job = await this.store.getJob(entry.job.id);
    if (!job || isTerminalStatus(job.status)) return;
    if (!keepsJobs(trigger)) {
      await this.store.cancelJob(job.id, { reason: TRIGGER_REMOVED });
      return;
    }
    if (job.status === "retrying" || job.status === "queued" || (retryPolicyFor(trigger) && RESUMABLE_INTERRUPTED_STATUSES.includes(job.status))) {
      this.startResumed(trigger, entry, job);
    }
  }

  private async restoreAdmitting(trigger: Trigger, state: PersistedTriggerState): Promise<void> {
    const entries = Object.entries(state.admitting ?? {});
    if (!entries.length) return;
    if (!keepsJobs(trigger)) {
      for (const [deliveryId] of entries) this.settleAdmission(trigger.id, deliveryId);
      return;
    }
    const seen = (await this.store.readDeliveriesSeen())[trigger.id] ?? {};
    for (const [deliveryId, entry] of entries) {
      if (entry.claimedAt !== undefined) {
        const seenAt = seen[deliveryId];
        if (seenAt === undefined) {
          this.settleAdmission(trigger.id, deliveryId);
          await this.runHandle(trigger, entry.activation, {});
          continue;
        }
        if (seenAt !== entry.claimedAt) {
          this.settleAdmission(trigger.id, deliveryId);
          await this.store.appendLedger({ event: "pollinate.delivery.duplicate", trigger_id: trigger.id, delivery_id: deliveryId, source: entry.activation.source });
          continue;
        }
      }
      await this.runHandle(trigger, entry.activation, { admitted: true });
    }
  }

  private async runHandle(trigger: Trigger, activation: Activation, options: HandleOptions): Promise<void> {
    await this.handle(trigger, activation, options).catch((error) => this.logAsyncError("restore admission", trigger, error));
  }

  private startResumed(trigger: Trigger, entry: DeliveryEntry, job: Job): void {
    const runtime = this.runtimeFor(trigger.id);
    runtime.running += 1;
    this.inFlight.add(job.id);
    runtime.inFlight.set(job.id, entry);
    this.runEntry(trigger, entry, job);
  }

  private runEntry(trigger: Trigger, entry: DeliveryEntry, resumedFrom?: Job): void {
    this.executeToTerminal(trigger, entry, resumedFrom)
      .catch((error) => {
        void this.store.appendLedger({
          event: "pollinate.job.errored",
          job_id: entry.job.id,
          trigger_id: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        }).catch((ledgerError) => this.logAsyncError("job error ledger", trigger, ledgerError));
      })
      .finally(() => {
        void this.finishEntry(trigger, entry.job.id).catch((error) => this.logAsyncError("finish", trigger, error));
      });
  }

  private async executeToTerminal(trigger: Trigger, entry: DeliveryEntry, resumedFrom?: Job): Promise<void> {
    let job = resumedFrom ? await this.resumeJob(trigger, entry, resumedFrom) : await this.executor.executeJob(entry.job, trigger, entry.activation, entry.batch);
    while (job.status === "retrying") {
      const before = this.triggers.get(trigger.id);
      if (!before || !keepsJobs(before)) {
        await this.store.cancelJob(job.id, { reason: TRIGGER_REMOVED });
        return;
      }
      await this.waitForRetry(job);
      if (this.stopping) return;
      const current = this.triggers.get(trigger.id);
      if (!current || !keepsJobs(current)) {
        await this.store.cancelJob(job.id, { reason: TRIGGER_REMOVED });
        return;
      }
      const latest = await this.store.getJob(job.id);
      if (latest?.status !== "retrying") return;
      job = await this.executor.executeJob(entry.job, current, entry.activation, entry.batch);
    }
  }

  private async resumeJob(trigger: Trigger, entry: DeliveryEntry, job: Job): Promise<Job> {
    if (job.status === "queued") return this.executor.executeJob(entry.job, trigger, entry.activation, entry.batch);
    const recoveredFrom = job.status;
    const resumed = job.status === "retrying" ? job : await this.executor.interruptAttempt(job, trigger);
    if (resumed.status !== "retrying") return resumed;
    await this.store.appendLedger({
      event: "pollinate.job.resumed",
      job_id: job.id,
      trigger_id: trigger.id,
      delivery_id: job.deliveryId,
      attempt: resumed.attempt,
      next_attempt_at: resumed.nextAttemptAt,
      recovered_from: recoveredFrom,
    });
    return resumed;
  }

  private waitForRetry(job: Job): Promise<void> {
    const dueAt = job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : Date.now();
    const delay = Math.max(0, (Number.isNaN(dueAt) ? Date.now() : dueAt) - Date.now());
    return new Promise((resolve) => {
      const wake = () => {
        const wait = this.retryWaits.get(job.id);
        if (wait) clearTimeout(wait.timer);
        this.retryWaits.delete(job.id);
        resolve();
      };
      this.retryWaits.set(job.id, { timer: setTimeout(wake, delay), wake });
    });
  }

  private async finishEntry(trigger: Trigger, jobId: string): Promise<void> {
    if (this.stopping) return;
    const runtime = this.runtimeFor(trigger.id);
    this.inFlight.delete(jobId);
    runtime.inFlight.delete(jobId);
    runtime.running = Math.max(0, runtime.running - 1);
    if (this.triggers.has(trigger.id)) await this.saveQueue(trigger.id);
    this.runDrain(this.triggers.get(trigger.id) ?? trigger);
  }

  private hasPendingJobs(triggerId: string): boolean {
    const runtime = this.runtime.get(triggerId);
    return Boolean(runtime?.queue.length || runtime?.inFlight.size);
  }

  private async cancelPendingJobs(triggerId: string): Promise<void> {
    const runtime = this.runtime.get(triggerId);
    const queued = runtime ? runtime.queue.splice(0) : (this.persisted[triggerId]?.queue ?? []);
    const inFlight = runtime ? [...runtime.inFlight.values()] : (this.persisted[triggerId]?.inFlight ?? []);
    for (const entry of queued) await this.store.cancelJob(entry.job.id, { reason: TRIGGER_REMOVED }).catch(() => undefined);
    for (const entry of inFlight) {
      const job = await this.store.getJob(entry.job.id);
      if (job?.status !== "retrying") continue;
      await this.store.cancelJob(job.id, { reason: TRIGGER_REMOVED });
      this.retryWaits.get(job.id)?.wake();
    }
    if (runtime && this.persisted[triggerId]) await this.saveQueue(triggerId);
  }

  private orphanedTriggerIds(): string[] {
    const ids = new Set([...Object.keys(this.persisted), ...this.runtime.keys()]);
    return [...ids].filter((id) => !this.triggers.has(id));
  }

  private pruneOrphanedState(orphaned: string[]): boolean {
    let changed = false;
    for (const triggerId of orphaned) {
      if (triggerId in this.persisted) {
        delete this.persisted[triggerId];
        changed = true;
      }
      const state = this.runtime.get(triggerId);
      if (!state) continue;
      if (state.timer) clearTimeout(state.timer);
      if (state.inFlight.size === 0) this.runtime.delete(triggerId);
      changed = true;
    }
    return changed;
  }

  private async handleThrottled(trigger: Trigger, activation: Activation, deliveryId: string): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "throttled") return null;
    const state = this.persistedFor(trigger.id);
    const now = Date.now();
    const throttleUntil = state.throttleUntil ? new Date(state.throttleUntil).getTime() : 0;
    if (now >= throttleUntil) {
      const members = mode.collect && state.pendingBatch?.length ? [...state.pendingBatch] : [];
      state.throttleUntil = new Date(now + parseDuration(mode.interval)).toISOString();
      this.setTimer(trigger, parseDuration(mode.interval), "throttled");
      const settle = () => {
        this.takePendingMembers(trigger.id, members.length);
        this.settleAdmission(trigger.id, deliveryId);
      };
      if (members.length) {
        const collected = [...members, activation];
        return this.enqueue(trigger, batchActivation(trigger.id, collected), collected.map((item) => item.payload), settle);
      }
      return this.enqueue(trigger, activation, [activation.payload], settle);
    }
    if (mode.collect) {
      state.pendingBatch = [...(state.pendingBatch ?? []), activation];
      this.settleAdmission(trigger.id, deliveryId);
      state.timerDueAt = new Date(throttleUntil).toISOString();
      state.timerKind = "throttled";
      this.setTimer(trigger, Math.max(0, throttleUntil - now), "throttled");
      await this.persist();
      return null;
    }
    this.settleAdmission(trigger.id, deliveryId);
    await this.persist();
    await this.store.appendLedger({ event: "pollinate.delivery.throttled", trigger_id: trigger.id, until: state.throttleUntil });
    return null;
  }

  private async handleBatched(trigger: Trigger, activation: Activation, deliveryId: string): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "batched") return null;
    const state = this.persistedFor(trigger.id);
    state.pendingBatch = [...(state.pendingBatch ?? []), activation];
    this.settleAdmission(trigger.id, deliveryId);
    if (!state.timerDueAt) state.timerDueAt = new Date(Date.now() + parseDuration(mode.window)).toISOString();
    state.timerKind = "batched";
    if (state.pendingBatch.length >= mode.maxBatch) {
      return this.flushPending(trigger);
    }
    this.setTimer(trigger, Math.max(0, new Date(state.timerDueAt).getTime() - Date.now()), "batched");
    await this.persist();
    return null;
  }

  private async handleDebounced(trigger: Trigger, activation: Activation, deliveryId: string): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "debounced") return null;
    const state = this.persistedFor(trigger.id);
    const now = Date.now();
    const quietMs = parseDuration(mode.quietPeriod);
    state.pendingBatch = [...(state.pendingBatch ?? []), activation];
    this.settleAdmission(trigger.id, deliveryId);
    const maxDueAt = this.debounceMaxDueAt(state.pendingBatch, quietMs, now);
    const dueAt = Math.min(now + quietMs, maxDueAt);
    state.timerDueAt = new Date(dueAt).toISOString();
    state.timerKind = "debounced";
    if (dueAt <= now) return this.flushPending(trigger);
    this.setTimer(trigger, dueAt - now, "debounced");
    await this.persist();
    return null;
  }

  private flushPending(trigger: Trigger): Promise<Job | null> {
    const previous = this.flushChains.get(trigger.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.flushPendingNow(trigger));
    this.flushChains.set(trigger.id, next);
    void next.finally(() => {
      if (this.flushChains.get(trigger.id) === next) this.flushChains.delete(trigger.id);
    }).catch(() => undefined);
    return next;
  }

  private async flushPendingNow(trigger: Trigger): Promise<Job | null> {
    const state = this.persistedFor(trigger.id);
    const pending = [...(state.pendingBatch ?? [])];
    if (pending.length === 0) return null;
    const activation = batchActivation(trigger.id, pending);
    const batch = pending.map((item) => item.payload);
    if (trigger.delivery.mode.strategy === "throttled") state.throttleUntil = new Date(Date.now() + parseDuration(trigger.delivery.mode.interval)).toISOString();
    const runtime = this.runtimeFor(trigger.id);
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = undefined;
    }
    return this.enqueue(trigger, activation, batch, () => this.takePendingMembers(trigger.id, pending.length));
  }

  private takePendingMembers(triggerId: string, count: number): void {
    const state = this.persistedFor(triggerId);
    const remaining = (state.pendingBatch ?? []).slice(count);
    if (remaining.length) {
      state.pendingBatch = remaining;
      return;
    }
    state.pendingBatch = undefined;
    if (count > 0) {
      state.timerDueAt = undefined;
      state.timerKind = undefined;
    }
  }

  private settleAdmission(triggerId: string, deliveryId: string): void {
    const state = this.persisted[triggerId];
    if (!state?.admitting?.[deliveryId]) return;
    const { [deliveryId]: _settled, ...rest } = state.admitting;
    state.admitting = Object.keys(rest).length ? rest : undefined;
  }

  private async enqueue(trigger: Trigger, activation: Activation, batch: JsonValue[], settle: () => void): Promise<Job | null> {
    const runtime = this.runtimeFor(trigger.id);
    const maxQueued = trigger.delivery.maxQueued ?? DEFAULT_MAX_QUEUED;
    if (runtime.queue.length >= maxQueued) {
      settle();
      await this.persist();
      await this.store.appendLedger({
        event: "pollinate.delivery.dropped",
        trigger_id: trigger.id,
        delivery_id: activation.metadata?.deliveryId,
        queued: runtime.queue.length,
        max_queued: maxQueued,
      });
      return null;
    }
    const job = await this.executor.createQueuedJob(trigger, activation, batch);
    await this.store.saveJob(job);
    const queuePosition = runtime.queue.length;
    settle();
    runtime.queue.push({ job, trigger, activation, batch });
    await this.saveQueue(trigger.id);
    await this.store.appendLedger({
      event: "pollinate.job.queued",
      job_id: job.id,
      trigger_id: trigger.id,
      queue_position: queuePosition,
      at: nowIso(),
    });
    this.runDrain(trigger);
    return job;
  }

  private async drain(trigger: Trigger): Promise<void> {
    const current = this.triggers.get(trigger.id);
    if (this.stopping || (current && !keepsJobs(current))) return;
    const runtime = this.runtimeFor(trigger.id);
    while (runtime.running < trigger.delivery.maxConcurrent && runtime.queue.length > 0) {
      const next = runtime.queue.shift();
      if (!next) return;
      const entry: DeliveryEntry = { job: next.job, activation: next.activation, batch: next.batch };
      runtime.running += 1;
      this.inFlight.add(next.job.id);
      runtime.inFlight.set(next.job.id, entry);
      let handedOff = false;
      try {
        await this.saveQueue(trigger.id);
        const latest = await this.store.getJob(next.job.id);
        if (latest?.status === "cancelled") continue;
        handedOff = true;
        this.runEntry(next.trigger, entry);
      } catch (error) {
        runtime.queue.unshift(next);
        runtime.inFlight.delete(next.job.id);
        await this.saveQueue(trigger.id).catch(() => undefined);
        throw error;
      } finally {
        if (!handedOff) {
          this.inFlight.delete(next.job.id);
          if (runtime.inFlight.delete(next.job.id)) await this.saveQueue(trigger.id).catch(() => undefined);
          runtime.running = Math.max(0, runtime.running - 1);
        }
      }
    }
  }

  private setTimer(trigger: Trigger, delayMs: number, kind: "throttled" | "batched" | "debounced"): void {
    const runtime = this.runtimeFor(trigger.id);
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      this.runFlushPending(trigger);
    }, delayMs);
    const state = this.persistedFor(trigger.id);
    state.timerKind = kind;
    state.timerDueAt = new Date(Date.now() + delayMs).toISOString();
  }

  private pendingTimerDelayMs(trigger: Trigger, state: PersistedTriggerState, now: number): number {
    let dueAt = state.timerDueAt ? this.timeMsOr(state.timerDueAt, now) : now;
    if (state.timerKind === "debounced" && trigger.delivery.mode.strategy === "debounced" && state.pendingBatch?.length) {
      dueAt = Math.min(dueAt, this.debounceMaxDueAt(state.pendingBatch, parseDuration(trigger.delivery.mode.quietPeriod), now));
    }
    return Math.max(0, dueAt - now);
  }

  private debounceMaxDueAt(pending: Activation[], quietMs: number, fallback: number): number {
    const first = pending[0];
    const firstSeenAt = first ? this.timeMsOr(first.receivedAt, fallback) : fallback;
    return firstSeenAt + quietMs * DEBOUNCE_MAX_WAIT_MULTIPLIER;
  }

  private timeMsOr(value: string, fallback: number): number {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  private runDrain(trigger: Trigger): void {
    void this.drain(trigger).catch((error) => this.logAsyncError("drain", trigger, error));
  }

  private runFlushPending(trigger: Trigger): void {
    void this.flushPending(trigger).catch((error) => this.logAsyncError("flushPending", trigger, error));
  }

  private async logAsyncError(operation: string, trigger: Trigger, error: unknown): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      await appendTextLine(daemonLogPath(this.store.root), `${nowIso()} delivery ${operation} failed for ${trigger.id}: ${message}`);
    } catch {
      return;
    }
  }

  private runtimeFor(triggerId: string): RuntimeState {
    let state = this.runtime.get(triggerId);
    if (!state) {
      state = { running: 0, queue: [], inFlight: new Map() };
      this.runtime.set(triggerId, state);
    }
    return state;
  }

  private persistedFor(triggerId: string): PersistedTriggerState {
    const state = this.persisted[triggerId] ?? {};
    this.persisted[triggerId] = state;
    return state;
  }

  private async saveQueue(triggerId: string): Promise<void> {
    const runtime = this.runtimeFor(triggerId);
    const state = this.persistedFor(triggerId);
    state.queue = runtime.queue.map(({ job, activation, batch }) => ({ job, activation, batch }));
    state.inFlight = runtime.inFlight.size ? [...runtime.inFlight.values()] : undefined;
    await this.persist();
  }

  private persist(): Promise<void> {
    const write = this.persistChain.then(() => this.store.writeDeliveryState(this.persisted));
    this.persistChain = write.catch(() => undefined);
    return write;
  }
}

function keepsJobs(trigger: Trigger): boolean {
  if (trigger.enabled) return true;
  const lifecycle = trigger.lifecycle;
  if (lifecycle?.maxDeliveries !== undefined && (lifecycle.deliveries ?? 0) >= lifecycle.maxDeliveries) return true;
  return trigger.source.kind === "schedule" && trigger.source.timing.type === "once";
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "errored" || status === "timed-out" || status === "cancelled";
}

function batchActivation(triggerId: string, members: Activation[]): Activation {
  const last = members[members.length - 1]!;
  const memberIds = members.map((member) => member.metadata?.deliveryId ?? deliveryIdFor(triggerId, `legacy:${member.receivedAt}`));
  return {
    ...last,
    metadata: {
      ...last.metadata,
      deliveryId: batchDeliveryId(triggerId, memberIds),
      deliveryIds: memberIds,
      stableDeliveryId: false,
    },
  };
}
