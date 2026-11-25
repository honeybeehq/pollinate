import { closeBinding, createBinding, type RouterActionExecutor, type RouterDeps } from "./router.js";
import { getRouterPlugin } from "./router-plugins/index.js";
import type { CanonicalRouterEvent, ExecutionProfile, RouterBinding, RouterConfig, Trigger } from "./types.js";
import type { PollinateStore } from "./store.js";
import type { HealthRecorder } from "./health.js";
import { nowIso, parseDuration } from "./time.js";

export type RouterGcOptions = {
  store: PollinateStore;
  executor: RouterActionExecutor;
  triggers: Trigger[];
  execution?: ExecutionProfile;
  health?: HealthRecorder;
  /** Errored bindings are retried this many times before being abandoned. */
  maxOpenRetries?: number;
  /** Pending bindings older than this are assumed interrupted and marked errored. */
  stalePendingMs?: number;
  /** Minimum quiet time before an active binding is reconciled against live subject state. */
  reconcileAfterMs?: number;
  maxCloseRetries?: number;
  closingRetryMs?: number;
  bindingRetentionMs?: number;
  now?: number;
};

export type RouterGcResult = {
  /** Binding ids closed because idleTtl elapsed without activity. */
  expired: string[];
  /** Binding ids closed because the subject (e.g. the PR) is no longer open. */
  reconciled: string[];
  /** Errored binding ids whose onOpen retry succeeded. */
  retried: string[];
  /** Errored binding ids whose onOpen retry failed again. */
  retryFailed: string[];
  /** Errored binding ids abandoned after exhausting retries (or lacking context). */
  abandoned: string[];
  /** Stale pending binding ids marked errored for the next retry pass. */
  staled: string[];
  closeRetried: string[];
  closeRetryFailed: string[];
  closeAbandoned: string[];
  pruned: string[];
  /** Unexpected per-binding GC errors. */
  errors: string[];
};

const DEFAULT_MAX_OPEN_RETRIES = 3;
const DEFAULT_STALE_PENDING_MS = 10 * 60_000;
const DEFAULT_RECONCILE_AFTER_MS = 5 * 60_000;
const DEFAULT_MAX_CLOSE_RETRIES = 3;
const DEFAULT_CLOSING_RETRY_MS = 10 * 60_000;
export const DEFAULT_IDLE_TTL = "7d";
export const DEFAULT_BINDING_RETENTION = "7d";

export function emptyRouterGcResult(): RouterGcResult {
  return { expired: [], reconciled: [], retried: [], retryFailed: [], abandoned: [], staled: [], closeRetried: [], closeRetryFailed: [], closeAbandoned: [], pruned: [], errors: [] };
}

export function routerGcSummary(result: RouterGcResult): string | undefined {
  const parts = Object.entries(result)
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => `${key}=${ids.length}`);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Sweeps router bindings for the lifecycle failure modes that webhook events
 * alone cannot heal: idleTtl expiry, errored onOpen retries, interrupted
 * (stale pending) opens, stuck onClose, bindings whose subject closed while
 * the daemon missed the close event, and expired closed binding files.
 */
export async function gcRouterBindings(options: RouterGcOptions): Promise<RouterGcResult> {
  const result = emptyRouterGcResult();
  for (const trigger of options.triggers) {
    const router = trigger.router;
    if (!router) continue;
    const bindings = await options.store.listRouterBindings({ triggerId: trigger.id });
    for (const binding of bindings) {
      try {
        await gcBinding(options, trigger, router, binding, result);
      } catch (error) {
        result.errors.push(`${binding.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return result;
}

async function gcBinding(
  options: RouterGcOptions,
  trigger: Trigger,
  router: RouterConfig,
  binding: RouterBinding,
  result: RouterGcResult,
): Promise<void> {
  const now = options.now ?? Date.now();
  const deps: RouterDeps = {
    store: options.store,
    executor: options.executor,
    trigger,
    cwd: trigger.cwd,
    health: options.health,
    executionFor: (_subjectKey, phase) => {
      const attempt = phase === "open" ? binding.openAttempts ?? 1 : phase === "close" ? (binding.closeAttempts ?? 0) + 1 : 1;
      return { triggerId: trigger.id, deliveryId: `gc:${binding.id}:${phase}:${attempt}`, attempt };
    },
  };

  if (binding.status === "closing") {
    await retryClosingBinding(options, deps, router, binding, now, result);
    return;
  }

  if (binding.status === "closed") {
    await pruneClosedBinding(options, trigger, router, binding, now, result);
    return;
  }

  if (binding.status === "active") {
    const idleTtl = router.idleTtl ?? DEFAULT_IDLE_TTL;
    if (now - lastTouchMs(binding) >= parseDuration(idleTtl)) {
      const closed = await withFreshBinding(options.store, trigger, binding, (current) =>
        closeBinding(deps, router, syntheticEvent(current, "pollinate.router.idle_expired"), current),
      );
      if (closed) {
        await options.store.appendLedger({
          event: "pollinate.router.binding_expired",
          trigger_id: trigger.id,
          router: router.plugin,
          subject_key: binding.subjectKey,
          reason: "idle-ttl",
          idle_ttl: idleTtl,
          target: binding.target?.handle,
        });
        result.expired.push(binding.id);
      }
      return;
    }
    await reconcileBinding(options, deps, router, binding, now, result);
    return;
  }

  if (binding.status === "pending") {
    const staleMs = options.stalePendingMs ?? DEFAULT_STALE_PENDING_MS;
    if (now - new Date(binding.updatedAt).getTime() < staleMs) return;
    const staled = await withFreshBinding(options.store, trigger, binding, async (current) => {
      await options.store.saveRouterBinding({
        ...current,
        status: "errored",
        updatedAt: nowIso(),
        error: "onOpen interrupted (binding stuck in pending)",
        openAttempts: (current.openAttempts ?? 0) + 1,
      });
    });
    if (staled) {
      await options.store.appendLedger({
        event: "pollinate.router.binding_errored",
        trigger_id: trigger.id,
        router: router.plugin,
        subject_key: binding.subjectKey,
        error: "onOpen interrupted (binding stuck in pending)",
      });
      result.staled.push(binding.id);
    }
    return;
  }

  if (binding.status === "errored") {
    const maxRetries = options.maxOpenRetries ?? DEFAULT_MAX_OPEN_RETRIES;
    if (!binding.context || (binding.openAttempts ?? 1) >= maxRetries + 1) {
      const abandoned = await withFreshBinding(options.store, trigger, binding, async (current) => {
        await options.store.saveRouterBinding({ ...current, status: "closed", updatedAt: nowIso() });
      });
      if (abandoned) {
        await options.store.appendLedger({
          event: "pollinate.router.binding_expired",
          trigger_id: trigger.id,
          router: router.plugin,
          subject_key: binding.subjectKey,
          reason: binding.context ? "open-retries-exhausted" : "no-open-context",
          error: binding.error,
        });
        await options.health?.recordFailure(trigger.id, {
          kind: "router_open",
          error: binding.error ?? (binding.context ? "open retries exhausted" : "no open context"),
        });
        result.abandoned.push(binding.id);
      }
      return;
    }
    try {
      const retried = await withFreshBinding(options.store, trigger, binding, async (current) => {
        await options.store.appendLedger({
          event: "pollinate.router.binding_retry",
          trigger_id: trigger.id,
          router: router.plugin,
          subject_key: binding.subjectKey,
          attempt: current.openAttempts ?? 1,
        });
        await createBinding(deps, router, syntheticEvent(current, current.lastEventKind ?? "pollinate.router.retry_open"), current);
      });
      if (retried) result.retried.push(binding.id);
    } catch {
      // createBinding already persisted the errored binding and ledgered the failure.
      result.retryFailed.push(binding.id);
    }
  }
}

async function retryClosingBinding(
  options: RouterGcOptions,
  deps: RouterDeps,
  router: RouterConfig,
  binding: RouterBinding,
  now: number,
  result: RouterGcResult,
): Promise<void> {
  if (now - new Date(binding.updatedAt).getTime() < (options.closingRetryMs ?? DEFAULT_CLOSING_RETRY_MS)) return;
  const maxAttempts = (options.maxCloseRetries ?? DEFAULT_MAX_CLOSE_RETRIES) + 1;
  let latest = binding;
  if ((binding.closeAttempts ?? 1) < maxAttempts) {
    try {
      const retried = await withFreshBinding(options.store, deps.trigger, binding, async (current) => {
        await options.store.appendLedger({
          event: "pollinate.router.binding_retry",
          trigger_id: deps.trigger.id,
          router: router.plugin,
          subject_key: binding.subjectKey,
          phase: "close",
          attempt: (current.closeAttempts ?? 1) + 1,
        });
        await closeBinding(deps, router, syntheticEvent(current, "pollinate.router.retry_close"), current);
      });
      if (retried) result.closeRetried.push(binding.id);
      return;
    } catch {
      result.closeRetryFailed.push(binding.id);
      const current = await options.store.getRouterBinding(deps.trigger.id, binding.subjectKey);
      if (current?.status !== "closing" || (current.closeAttempts ?? 1) < maxAttempts) return;
      latest = current;
    }
  }
  const abandoned = await withFreshBinding(options.store, deps.trigger, latest, async (current) => {
    await options.store.saveRouterBinding({ ...current, status: "closed", updatedAt: nowIso() });
  });
  if (abandoned) {
    await options.store.appendLedger({
      event: "pollinate.router.binding_expired",
      trigger_id: deps.trigger.id,
      router: router.plugin,
      subject_key: binding.subjectKey,
      reason: "close-retries-exhausted",
      error: latest.error,
      target: binding.target?.handle,
    });
    result.closeAbandoned.push(binding.id);
  }
}

async function pruneClosedBinding(
  options: RouterGcOptions,
  trigger: Trigger,
  router: RouterConfig,
  binding: RouterBinding,
  now: number,
  result: RouterGcResult,
): Promise<void> {
  const retentionMs = options.bindingRetentionMs ?? parseDuration(DEFAULT_BINDING_RETENTION);
  if (now - new Date(binding.updatedAt).getTime() < retentionMs) return;
  const pruned = await withFreshBinding(options.store, trigger, binding, () => options.store.deleteRouterBinding(trigger.id, binding.subjectKey));
  if (pruned) {
    await options.store.appendLedger({
      event: "pollinate.router.binding_pruned",
      trigger_id: trigger.id,
      router: router.plugin,
      subject_key: binding.subjectKey,
      closed_at: binding.updatedAt,
    });
    result.pruned.push(binding.id);
  }
}

async function reconcileBinding(
  options: RouterGcOptions,
  deps: RouterDeps,
  router: RouterConfig,
  binding: RouterBinding,
  now: number,
  result: RouterGcResult,
): Promise<void> {
  const reconcileAfterMs = options.reconcileAfterMs ?? DEFAULT_RECONCILE_AFTER_MS;
  const lastChecked = binding.checkedAt ?? binding.lastActivityAt ?? binding.updatedAt;
  if (now - new Date(lastChecked).getTime() < reconcileAfterMs) return;
  const plugin = await getRouterPlugin(router.plugin, { root: options.store.root, cwd: deps.cwd });
  if (!plugin.subjectState) return;
  const state = await plugin.subjectState(binding.subjectKey, { cwd: deps.cwd, execution: options.execution });
  if (state === "closed") {
    const closed = await withFreshBinding(options.store, deps.trigger, binding, (current) =>
      closeBinding(deps, router, syntheticEvent(current, "pollinate.router.reconcile_closed"), current),
    );
    if (closed) {
      await options.store.appendLedger({
        event: "pollinate.router.binding_reconciled",
        trigger_id: deps.trigger.id,
        router: router.plugin,
        subject_key: binding.subjectKey,
        subject_state: state,
        target: binding.target?.handle,
      });
      result.reconciled.push(binding.id);
    }
    return;
  }
  await withFreshBinding(options.store, deps.trigger, binding, async (current) => {
    await options.store.saveRouterBinding({ ...current, checkedAt: nowIso() });
  });
}

/**
 * Re-reads the binding under its lock and runs fn only if it is unchanged
 * since the sweep observed it, so the GC never clobbers a concurrent live event.
 */
async function withFreshBinding(
  store: PollinateStore,
  trigger: Trigger,
  observed: RouterBinding,
  fn: (current: RouterBinding) => Promise<unknown>,
): Promise<boolean> {
  return store.withRouterBindingLock(trigger.id, observed.subjectKey, async () => {
    const current = await store.getRouterBinding(trigger.id, observed.subjectKey);
    if (!current || current.status !== observed.status || current.updatedAt !== observed.updatedAt) return false;
    await fn(current);
    return true;
  });
}

function syntheticEvent(binding: RouterBinding, kind: string): CanonicalRouterEvent {
  return { subjectKey: binding.subjectKey, kind, payload: { ...(binding.context ?? {}), event_kind: kind } };
}

function lastTouchMs(binding: RouterBinding): number {
  return new Date(binding.lastActivityAt ?? binding.updatedAt).getTime();
}
