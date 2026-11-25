import { randomBytes } from "node:crypto";
import type { Action, Delivery, Trigger } from "./types.js";
import { PollinateStore } from "./store.js";
import { isoAfter, nowIso, parseDuration } from "./time.js";

export type HookCreateOptions = {
  id: string;
  name?: string;
  path?: string;
  ttl?: string;
  baseUrl?: string;
  secret?: string;
  transform?: Record<string, string>;
  maxDeliveries?: number;
  action: Action;
  delivery?: Delivery;
  tags?: string[];
};

export type HookCreateResult = {
  id: string;
  path: string;
  url?: string;
  expiresAt?: string;
  maxDeliveries?: number;
  trigger: Trigger;
};

export function createWebhookHook(options: HookCreateOptions, now = new Date()): HookCreateResult {
  const path = normalizeHookPath(options.path ?? `tmp/${randomHookToken()}`);
  const ttlMs = options.ttl ? parseDuration(options.ttl) : undefined;
  const expiresAt = ttlMs === undefined ? undefined : isoAfter(ttlMs, now);
  const createdAt = now.toISOString();
  const trigger: Trigger = {
    id: options.id,
    name: options.name ?? options.id,
    tags: options.tags ?? [],
    enabled: true,
    source: { kind: "webhook", webhook: { path, secret: options.secret, transform: options.transform } },
    delivery: options.delivery ?? { mode: { strategy: "immediate" }, maxConcurrent: 1 },
    lifecycle: {
      temporary: true,
      expiresAt,
      maxDeliveries: options.maxDeliveries,
      deliveries: 0,
    },
    action: options.action,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    id: trigger.id,
    path,
    url: options.baseUrl ? hookUrl(options.baseUrl, path) : undefined,
    expiresAt,
    maxDeliveries: options.maxDeliveries,
    trigger,
  };
}

export function hookUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/hook/${normalizeHookPath(path).split("/").map(encodeURIComponent).join("/")}`;
}

export function randomHookToken(): string {
  return randomBytes(18).toString("hex");
}

export function normalizeHookPath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function isExpiredTemporaryHook(trigger: Trigger, now = Date.now()): boolean {
  if (!trigger.lifecycle?.temporary || !trigger.lifecycle.expiresAt) return false;
  return new Date(trigger.lifecycle.expiresAt).getTime() <= now;
}

export async function expireTemporaryHook(store: PollinateStore, trigger: Trigger): Promise<Trigger> {
  if (!trigger.lifecycle?.temporary || !trigger.enabled) return trigger;
  const updated = { ...trigger, enabled: false, updatedAt: nowIso() };
  await store.saveTrigger(updated);
  await store.appendLedger({ event: "pollinate.hook.expired", trigger_id: trigger.id });
  return updated;
}

export async function recordWebhookDelivery(store: PollinateStore, trigger: Trigger): Promise<Trigger> {
  if (!trigger.lifecycle) return trigger;
  const deliveries = (trigger.lifecycle.deliveries ?? 0) + 1;
  const maxDeliveries = trigger.lifecycle.maxDeliveries;
  const maxReached = maxDeliveries !== undefined && deliveries >= maxDeliveries;
  const updated = {
    ...trigger,
    enabled: maxReached ? false : trigger.enabled,
    lifecycle: { ...trigger.lifecycle, deliveries },
    updatedAt: nowIso(),
  };
  await store.saveTrigger(updated);
  await store.appendLedger({
    event: "pollinate.hook.delivered",
    trigger_id: trigger.id,
    deliveries,
    max_deliveries: maxDeliveries,
    disabled: maxReached,
  });
  return updated;
}

export type TemporaryTriggerGcOptions = {
  now?: number;
  hasLiveJobs?: (triggerId: string) => boolean;
  triggers?: readonly Trigger[];
};

export async function gcTemporaryHooks(store: PollinateStore, options: TemporaryTriggerGcOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const triggers = options.triggers ?? (await store.scanTriggerFiles()).triggers;
  const candidates = triggers
    .filter((trigger) => trigger.lifecycle?.temporary && lifecycleEnded(trigger, now))
    .filter((trigger) => !options.hasLiveJobs?.(trigger.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length === 0) return [];
  const live = await store.triggersWithLiveJobs(new Set(candidates.map((trigger) => trigger.id)));
  const removed: string[] = [];
  for (const trigger of candidates) {
    if (live.has(trigger.id)) continue;
    await store.appendLedger({
      event: "pollinate.trigger.spent",
      trigger_id: trigger.id,
      reason: isExpiredTemporaryHook(trigger, now) ? "expired" : "max_deliveries",
      source: trigger.source.kind,
      deliveries: trigger.lifecycle?.deliveries ?? 0,
      ...(trigger.lifecycle?.maxDeliveries !== undefined ? { max_deliveries: trigger.lifecycle.maxDeliveries } : {}),
      ...(trigger.lifecycle?.expiresAt ? { expires_at: trigger.lifecycle.expiresAt } : {}),
    });
    await store.removeTrigger(trigger.id);
    if (trigger.source.kind === "webhook") await store.appendLedger({ event: "pollinate.hook.gc_removed", trigger_id: trigger.id });
    removed.push(trigger.id);
  }
  return removed;
}

export function lifecycleEnded(trigger: Trigger, now = Date.now()): boolean {
  return lifecycleExpired(trigger, now) || reachedMaxDeliveries(trigger);
}

function lifecycleExpired(trigger: Trigger, now: number): boolean {
  const expiresAt = trigger.lifecycle?.expiresAt;
  return expiresAt !== undefined && new Date(expiresAt).getTime() <= now;
}

function reachedMaxDeliveries(trigger: Trigger): boolean {
  const max = trigger.lifecycle?.maxDeliveries;
  return max !== undefined && (trigger.lifecycle?.deliveries ?? 0) >= max;
}
