import { renderAction } from "./templates.js";
import type { ActionExecutionContext, ActionResult } from "./actions.js";
import { matchesFilter } from "./filter.js";
import { getRouterPlugin } from "./router-plugins/index.js";
import type { Activation, Action, CanonicalRouterEvent, JsonValue, RouterBinding, RouterConfig, Trigger } from "./types.js";
import type { PollinateStore } from "./store.js";
import type { HealthRecorder } from "./health.js";
import { nowIso } from "./time.js";

export type RouterActionExecutor = {
  executeAction(action: Action, cwd?: string, execution?: ActionExecutionContext): Promise<ActionResult>;
};

export type RouterPhase = "open" | "activity" | "close";

export type RouterDeps = {
  store: PollinateStore;
  executor: RouterActionExecutor;
  trigger: Trigger;
  cwd?: string;
  executionFor?: (subjectKey: string, phase: RouterPhase) => ActionExecutionContext;
  health?: HealthRecorder;
};

export type ExecuteRouterOptions = RouterDeps & {
  activation: Activation;
  execution?: ActionExecutionContext;
};

export type RouterEventResult =
  | { subjectKey: string; kind: string; outcome: "created"; target: string }
  | { subjectKey: string; kind: string; outcome: "routed"; target: string }
  | { subjectKey: string; kind: string; outcome: "closed"; target: string }
  | { subjectKey: string; kind: string; outcome: "already-bound"; target?: string }
  | { subjectKey: string; kind: string; outcome: "dropped"; reason: string };

export async function executeRouter(options: ExecuteRouterOptions): Promise<{ plugin: string; events: RouterEventResult[] }> {
  const router = options.trigger.router;
  if (!router) throw new Error(`Trigger ${options.trigger.id} has no router`);
  const plugin = await getRouterPlugin(router.plugin, { root: options.store.root, cwd: options.cwd });
  const input = routerInput(options.activation);
  const events = await plugin.normalize(input);
  const results: RouterEventResult[] = [];
  const execution = options.execution;
  const scoped: ExecuteRouterOptions = execution
    ? { ...options, executionFor: (subjectKey, phase) => ({ ...execution, deliveryId: `${execution.deliveryId}:${subjectKey}:${phase}` }) }
    : options;
  for (const event of events) {
    results.push(await handleRouterEvent(scoped, router, event));
  }
  return { plugin: plugin.name, events: results };
}

function routerInput(activation: Activation): { headers: Record<string, string>; body: JsonValue; path?: string } {
  const headers = activation.metadata?.webhook?.headers ?? {};
  const path = activation.metadata?.webhook?.path;
  return { headers, body: activation.payload, path };
}

async function handleRouterEvent(
  options: ExecuteRouterOptions,
  router: RouterConfig,
  event: CanonicalRouterEvent,
): Promise<RouterEventResult> {
  return options.store.withRouterBindingLock(options.trigger.id, event.subjectKey, async () => {
    const current = await options.store.getRouterBinding(options.trigger.id, event.subjectKey);
    if (router.openOn.includes(event.kind)) {
      if (!matchesFilter(router.openWhen, event.payload)) {
        await options.store.appendLedger({
          event: "pollinate.router.open_filtered",
          trigger_id: options.trigger.id,
          router: router.plugin,
          subject_key: event.subjectKey,
          event_kind: event.kind,
        });
        return { subjectKey: event.subjectKey, kind: event.kind, outcome: "dropped", reason: "openWhen filter" };
      }
      if (current?.target && current.status !== "closed" && current.status !== "errored") {
        await options.store.appendLedger({
          event: "pollinate.router.already_bound",
          trigger_id: options.trigger.id,
          router: router.plugin,
          subject_key: event.subjectKey,
          event_kind: event.kind,
          target: current.target.handle,
        });
        return { subjectKey: event.subjectKey, kind: event.kind, outcome: "already-bound", target: current.target.handle };
      }
      return createBinding(options, router, event, current);
    }

    if (!current?.target) {
      await options.store.appendLedger({
        event: "pollinate.router.unbound",
        trigger_id: options.trigger.id,
        router: router.plugin,
        subject_key: event.subjectKey,
        event_kind: event.kind,
      });
      return { subjectKey: event.subjectKey, kind: event.kind, outcome: "dropped", reason: "no binding" };
    }

    if (router.closeOn.includes(event.kind)) return closeBinding(options, router, event, current);
    return routeToBinding(options, router, event, current);
  });
}

export async function createBinding(
  deps: RouterDeps,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  existing: RouterBinding | null,
): Promise<RouterEventResult> {
  const now = nowIso();
  const pending: RouterBinding = existing
    ? { ...existing, status: "pending", target: undefined, error: undefined, updatedAt: now }
    : {
        id: bindingId(deps.trigger.id, event.subjectKey),
        triggerId: deps.trigger.id,
        router: router.plugin,
        subjectKey: event.subjectKey,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
  await deps.store.saveRouterBinding({ ...pending, status: "pending", updatedAt: now, lastEventKind: event.kind, context: event.payload });
  await deps.store.appendLedger({
    event: "pollinate.router.binding_pending",
    trigger_id: deps.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
  });

  try {
    const execution = deps.executionFor?.(event.subjectKey, "open");
    const rendered = renderRouterAction(router.onOpen, event, pending, execution);
    const result = await deps.executor.executeAction(rendered, deps.cwd, execution);
    const handles = result.handles && isStringRecord(result.handles) ? result.handles : undefined;
    const handle = typeof result.handle === "string" ? result.handle : handles ? Object.values(handles)[0] : honeybeeSpawnName(rendered);
    if (!handle) throw new Error("Router onOpen action did not produce a target handle");
    const active: RouterBinding = {
      ...pending,
      status: "active",
      target: { kind: "hive", handle, ...(handles ? { handles } : {}) },
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
      lastEventKind: event.kind,
      error: undefined,
      context: event.payload,
      openAttempts: undefined,
    };
    await deps.store.saveRouterBinding(active);
    await deps.store.appendLedger({
      event: "pollinate.router.binding_created",
      trigger_id: deps.trigger.id,
      router: router.plugin,
      subject_key: event.subjectKey,
      event_kind: event.kind,
      target: handle,
    });
    return { subjectKey: event.subjectKey, kind: event.kind, outcome: "created", target: handle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.saveRouterBinding({
      ...pending,
      status: "errored",
      updatedAt: nowIso(),
      lastEventKind: event.kind,
      error: message,
      context: event.payload,
      openAttempts: (pending.openAttempts ?? 0) + 1,
    });
    await deps.store.appendLedger({
      event: "pollinate.router.binding_errored",
      trigger_id: deps.trigger.id,
      router: router.plugin,
      subject_key: event.subjectKey,
      event_kind: event.kind,
      error: message,
    });
    throw error;
  }
}

async function routeToBinding(
  deps: RouterDeps,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  binding: RouterBinding,
): Promise<RouterEventResult> {
  const execution = deps.executionFor?.(event.subjectKey, "activity");
  const action = renderRouterAction(router.onActivity, event, binding, execution);
  try {
    await deps.executor.executeAction(action, deps.cwd, execution);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.saveRouterBinding({ ...binding, updatedAt: nowIso(), lastEventKind: event.kind, error: message });
    await deps.store.appendLedger({
      event: "pollinate.router.activity_errored",
      trigger_id: deps.trigger.id,
      router: router.plugin,
      subject_key: event.subjectKey,
      event_kind: event.kind,
      target: binding.target?.handle,
      error: message,
    });
    throw error;
  }
  const updated = {
    ...binding,
    status: "active" as const,
    updatedAt: nowIso(),
    lastActivityAt: nowIso(),
    lastEventKind: event.kind,
    error: undefined,
  };
  await deps.store.saveRouterBinding(updated);
  await deps.store.appendLedger({
    event: "pollinate.router.binding_routed",
    trigger_id: deps.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
    target: binding.target?.handle,
  });
  return { subjectKey: event.subjectKey, kind: event.kind, outcome: "routed", target: binding.target!.handle };
}

export async function closeBinding(
  deps: RouterDeps,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  binding: RouterBinding,
): Promise<RouterEventResult> {
  const closing = { ...binding, status: "closing" as const, updatedAt: nowIso(), lastEventKind: event.kind };
  await deps.store.saveRouterBinding(closing);
  const execution = deps.executionFor?.(event.subjectKey, "close");
  const action = renderRouterAction(router.onClose ?? defaultCloseAction(), event, closing, execution);
  try {
    await deps.executor.executeAction(action, deps.cwd, execution);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.health?.recordFailure(deps.trigger.id, { kind: "router_close", error: message, deliveryId: execution?.deliveryId });
    throw error;
  }
  const closed = { ...closing, status: "closed" as const, updatedAt: nowIso(), lastActivityAt: nowIso() };
  await deps.store.saveRouterBinding(closed);
  await deps.store.appendLedger({
    event: "pollinate.router.binding_closed",
    trigger_id: deps.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
    target: binding.target?.handle,
  });
  return { subjectKey: event.subjectKey, kind: event.kind, outcome: "closed", target: binding.target!.handle };
}

function renderRouterAction(action: Action, event: CanonicalRouterEvent, binding: RouterBinding, execution?: ActionExecutionContext): Action {
  const context: Record<string, unknown> = {
    ...event.payload,
    ...(execution ? { delivery_id: execution.deliveryId, attempt: String(execution.attempt), ...(execution.jobId ? { job_id: execution.jobId } : {}) } : {}),
    event_kind: event.kind,
    subject_key: event.subjectKey,
    binding_id: binding.id,
    target: binding.target?.handle ?? "",
    "binding.target": binding.target?.handle ?? "",
    ...(binding.target?.handles ? bindingTargetVars(binding.target.handles) : {}),
  };
  return renderAction(action, context).value;
}

function defaultCloseAction(): Action {
  return { kind: "honeybee", run: "kill", target: "{{binding.target}}" };
}

function honeybeeSpawnName(action: Action): string | undefined {
  return action.kind === "honeybee" && action.run === "spawn" ? action.name : undefined;
}

function bindingTargetVars(handles: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(handles).map(([key, value]) => [`binding.targets.${key}`, value]));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function bindingId(triggerId: string, subjectKey: string): string {
  return `${safePart(triggerId)}.${safePart(subjectKey)}`;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "binding";
}
