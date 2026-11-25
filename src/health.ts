import { setTimeout as sleep } from "node:timers/promises";
import { defaultRetryOn, type ActionExecutor } from "./actions.js";
import { deliveryIdFor } from "./delivery.js";
import { appendTextLine, daemonLogPath } from "./fsx.js";
import type { InvalidTrigger, PollinateStore } from "./store.js";
import { nowIso, parseDuration } from "./time.js";
import type { Action, Activation, FailureKind, OnFailurePolicy, RetryPolicy, Trigger, TriggerHealth, TriggerHealthEntry } from "./types.js";

export const FAILURE_ERROR_MAX_CHARS = 2_000;
export const DEFAULT_ON_FAILURE_AFTER = 1;
export const DEFAULT_ON_FAILURE_COOLDOWN = "1h";
export const NOTIFICATION_RETRY: RetryPolicy = { maxAttempts: 3, backoff: "10s", maxBackoff: "20s", maxElapsed: "1m" };
const SUCCESS_STAMP_INTERVAL_MS = 60_000;

export type SuccessKind = "job" | "poll" | "load";

const RECOVERED_BY: Record<SuccessKind, readonly FailureKind[]> = {
  job: ["job", "schedule", "router_open", "router_close"],
  poll: ["poll"],
  load: ["invalid"],
};

export type TriggerFailure = { kind: FailureKind; error: string; jobId?: string; deliveryId?: string };

export type HealthRecorder = {
  recordFailure(triggerId: string, failure: TriggerFailure): Promise<void>;
  recordSuccess(triggerId: string, kind: SuccessKind): Promise<void>;
};

export type ResolvedOnFailure = { after: number; cooldownMs: number; action: Action };

export type TriggerHealthMonitorOptions = {
  defaults?: OnFailurePolicy;
  triggerFor: (triggerId: string) => Trigger | undefined;
  notificationRetry?: RetryPolicy;
};

export function resolveOnFailure(own: OnFailurePolicy | undefined, defaults: OnFailurePolicy | undefined): ResolvedOnFailure | undefined {
  const merged: OnFailurePolicy = { ...defaults, ...own };
  if (merged.disabled || !merged.action) return undefined;
  return {
    after: merged.after ?? DEFAULT_ON_FAILURE_AFTER,
    cooldownMs: parseDuration(merged.cooldown ?? DEFAULT_ON_FAILURE_COOLDOWN),
    action: merged.action,
  };
}

export function notificationDue(entry: TriggerHealthEntry, policy: ResolvedOnFailure, nowMs: number): boolean {
  if (entry.consecutiveFailures < policy.after) return false;
  if (!entry.notifiedAt) return true;
  const notifiedMs = Date.parse(entry.notifiedAt);
  if (Number.isNaN(notifiedMs) || notifiedMs < Date.parse(entry.firstFailedAt ?? "")) return true;
  return nowMs - notifiedMs >= policy.cooldownMs;
}

export function cutFailureError(error: string): string {
  return error.length > FAILURE_ERROR_MAX_CHARS ? error.slice(0, FAILURE_ERROR_MAX_CHARS) : error;
}

export function failureVars(triggerId: string, triggerName: string, entry: TriggerHealthEntry, failure: TriggerFailure): Record<string, string> {
  return {
    trigger_id: triggerId,
    trigger_name: triggerName,
    failure_kind: failure.kind,
    failure_error: cutFailureError(failure.error),
    failed_job_id: failure.jobId ?? "",
    delivery_id: failure.deliveryId ?? "",
    consecutive_failures: String(entry.consecutiveFailures),
    first_failed_at: entry.firstFailedAt ?? "",
  };
}

export function notificationRetryOn(action: Action): string[] {
  return [...new Set([...defaultRetryOn(action), "exit", "timeout"])];
}

export class TriggerHealthMonitor implements HealthRecorder {
  private entries = new Map<string, TriggerHealthEntry>();
  private readonly notifications = new Set<Promise<void>>();
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly store: PollinateStore,
    private readonly executor: ActionExecutor,
    private readonly options: TriggerHealthMonitorOptions,
  ) {}

  async load(): Promise<void> {
    this.remember(await this.store.readTriggerHealth());
  }

  async syncTriggerFiles(triggers: Trigger[], invalid: InvalidTrigger[]): Promise<void> {
    for (const file of invalid) {
      const known = this.entries.get(file.id);
      if (known?.consecutiveFailures && known.lastFailureKind === "invalid" && known.lastError === cutFailureError(file.error)) continue;
      await this.recordFailure(file.id, { kind: "invalid", error: file.error });
    }
    for (const trigger of triggers) await this.recordSuccess(trigger.id, "load");
  }

  async recordFailure(triggerId: string, failure: TriggerFailure): Promise<void> {
    try {
      const trigger = this.options.triggerFor(triggerId);
      if (!trigger && failure.kind !== "invalid") return;
      const at = nowIso();
      const error = cutFailureError(failure.error);
      const policy = resolveOnFailure(trigger?.onFailure, this.options.defaults);
      const decision = { notify: false };
      const health = await this.store.updateTriggerHealth(triggerId, (current) => {
        const streak = current?.consecutiveFailures ?? 0;
        const next: TriggerHealthEntry = {
          ...current,
          consecutiveFailures: streak + 1,
          firstFailedAt: streak > 0 ? (current?.firstFailedAt ?? at) : at,
          lastFailureAt: at,
          lastFailureKind: failure.kind,
          lastError: error,
        };
        decision.notify = policy !== undefined && notificationDue(next, policy, Date.parse(at));
        if (decision.notify) next.notifiedAt = at;
        return next;
      });
      this.remember(health);
      const entry = health[triggerId]!;
      await this.store.appendLedger({
        event: "pollinate.trigger.failed",
        trigger_id: triggerId,
        kind: failure.kind,
        error,
        ...(failure.jobId ? { job_id: failure.jobId } : {}),
        ...(failure.deliveryId ? { delivery_id: failure.deliveryId } : {}),
        consecutive: entry.consecutiveFailures,
      });
      if (decision.notify && policy) this.startNotification(triggerId, trigger?.name ?? triggerId, policy, entry, failure);
    } catch (error) {
      await this.log(`recording a ${failure.kind} failure for ${triggerId} failed: ${messageOf(error)}`);
    }
  }

  async recordSuccess(triggerId: string, kind: SuccessKind): Promise<void> {
    try {
      if (!this.options.triggerFor(triggerId)) return;
      const known = this.entries.get(triggerId);
      const nowMs = Date.now();
      const stamps = kind !== "load";
      if (!recovers(known, kind) && (!stamps || stampedSince(known?.lastSuccessAt, nowMs))) return;
      const at = new Date(nowMs).toISOString();
      const outcome: { recovered?: TriggerHealthEntry } = {};
      const health = await this.store.updateTriggerHealth(triggerId, (current) => {
        const next: TriggerHealthEntry = { ...current, consecutiveFailures: current?.consecutiveFailures ?? 0 };
        if (stamps) next.lastSuccessAt = at;
        if (recovers(current, kind)) {
          outcome.recovered = current;
          next.consecutiveFailures = 0;
        }
        return next;
      });
      this.remember(health);
      const recovered = outcome.recovered;
      if (!recovered) return;
      await this.store.appendLedger({
        event: "pollinate.trigger.recovered",
        trigger_id: triggerId,
        kind: recovered.lastFailureKind,
        consecutive: recovered.consecutiveFailures,
        first_failed_at: recovered.firstFailedAt,
      });
    } catch (error) {
      await this.log(`recording a ${kind} success for ${triggerId} failed: ${messageOf(error)}`);
    }
  }

  async idle(): Promise<void> {
    while (this.notifications.size) await Promise.allSettled([...this.notifications]);
  }

  shutdown(): void {
    this.shutdownController.abort();
  }

  private remember(health: TriggerHealth): void {
    this.entries = new Map(Object.entries(health));
  }

  private startNotification(triggerId: string, triggerName: string, policy: ResolvedOnFailure, entry: TriggerHealthEntry, failure: TriggerFailure): void {
    const run = this.runNotification(triggerId, triggerName, policy, entry, failure).catch((error) =>
      this.notificationErrored({ trigger_id: triggerId, error: messageOf(error) }),
    );
    this.notifications.add(run);
    void run.finally(() => this.notifications.delete(run));
  }

  private async runNotification(triggerId: string, triggerName: string, policy: ResolvedOnFailure, entry: TriggerHealthEntry, failure: TriggerFailure): Promise<void> {
    const at = entry.notifiedAt ?? nowIso();
    const vars = failureVars(triggerId, triggerName, entry, failure);
    const notifier = notificationTrigger(triggerId, triggerName, policy.action, vars, this.options.notificationRetry ?? NOTIFICATION_RETRY, at);
    const activation: Activation = {
      triggerId,
      source: "failure",
      payload: vars,
      receivedAt: at,
      metadata: { deliveryId: deliveryIdFor(triggerId, `failure:${at}`) },
    };
    const job = await this.executor.createQueuedJob(notifier, activation, [vars]);
    await this.store.saveJob(job);
    await this.store.appendLedger({ event: "pollinate.job.queued", job_id: job.id, trigger_id: triggerId, source: "failure", queue_position: 0, at: nowIso() });
    let current = await this.executor.executeJob(job, notifier, activation, [vars]);
    while (current.status === "retrying") {
      if (!(await this.waitUntil(current.nextAttemptAt))) return;
      current = await this.executor.executeJob(job, notifier, activation, [vars]);
    }
    if (current.status === "errored" || current.status === "timed-out") {
      await this.notificationErrored({
        trigger_id: triggerId,
        job_id: current.id,
        error: current.status === "timed-out" ? "action timed out" : (current.error ?? "notification failed"),
        attempts: current.attempt,
      });
    }
  }

  private async notificationErrored(fields: Record<string, unknown>): Promise<void> {
    try {
      await this.store.appendLedger({ event: "pollinate.trigger.on_failure_errored", ...fields });
    } catch (error) {
      await this.log(`onFailure notification for ${String(fields.trigger_id)} failed: ${messageOf(error)}`);
    }
  }

  private async waitUntil(at: string | undefined): Promise<boolean> {
    const dueMs = at ? Date.parse(at) : Number.NaN;
    const delayMs = Number.isNaN(dueMs) ? 0 : Math.max(0, dueMs - Date.now());
    try {
      await sleep(delayMs, undefined, { signal: this.shutdownController.signal });
      return true;
    } catch {
      return false;
    }
  }

  private async log(message: string): Promise<void> {
    try {
      await appendTextLine(daemonLogPath(this.store.root), `${nowIso()} trigger health: ${message}`);
    } catch {
      return;
    }
  }
}

function notificationTrigger(triggerId: string, name: string, action: Action, vars: Record<string, string>, retry: RetryPolicy, at: string): Trigger {
  return {
    id: triggerId,
    name,
    tags: [],
    enabled: true,
    source: { kind: "manual" },
    delivery: { mode: { strategy: "immediate" }, maxConcurrent: 1 },
    retry: { ...retry, on: notificationRetryOn(action) },
    context: { static: vars },
    action,
    createdAt: at,
    updatedAt: at,
  };
}

function recovers(entry: TriggerHealthEntry | undefined, kind: SuccessKind): boolean {
  return Boolean(entry && entry.consecutiveFailures > 0 && entry.lastFailureKind && RECOVERED_BY[kind].includes(entry.lastFailureKind));
}

function stampedSince(lastSuccessAt: string | undefined, nowMs: number): boolean {
  if (!lastSuccessAt) return false;
  const stampedMs = Date.parse(lastSuccessAt);
  return !Number.isNaN(stampedMs) && nowMs - stampedMs < SUCCESS_STAMP_INTERVAL_MS;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
