import { setTimeout as sleep } from "node:timers/promises";
import type { Action, Activation, DryRunResult, ExecutionProfile, Job, JobAttempt, JsonValue, RetryPolicy, SourceKind, Trigger } from "./types.js";
import type { PollinateStore } from "./store.js";
import { resolveContext } from "./context.js";
import { renderAction, renderString } from "./templates.js";
import { execShell, type ExecResult } from "./process.js";
import { DEFAULT_HIVE_STARTING_WAIT_MS, execHive, withHiveStartingObserver, type HiveStartingObserver } from "./hive-exec.js";
import { nowIso, parseDuration } from "./time.js";
import { executeRouter } from "./router.js";
import { activationDeliveryIds, admitDelivery, deliveryIdFor, withDeliveryId } from "./delivery.js";

export type ActionExecutorOptions = {
  contextTimeoutMs: number;
  commandTimeoutMs: number;
  hiveStartingWaitMs?: number;
  execution?: ExecutionProfile;
};

export type ActionResult = { timedOut?: boolean; handle?: string; handles?: Record<string, string>; [key: string]: unknown };

export type ActionExecutionContext = {
  triggerId: string;
  deliveryId: string;
  jobId?: string;
  attempt: number;
};

const FIRST_ATTEMPT = 1;
const MAX_ATTEMPT_RECORDS = 10;
const RETRY_JITTER = 0.2;
const HTTP_RETRY_ON = ["transport", "timeout", "status:408", "status:429", "status:5xx"];
const HIVE_RETRY_ON = ["hived_handover_stalled", "socket_unreachable", "timeout"];

export class ActionFailure extends Error {
  constructor(
    message: string,
    readonly codes: string[],
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ActionFailure";
  }
}

export function retryPolicyFor(trigger: Trigger): RetryPolicy | undefined {
  if (!trigger.action || !trigger.retry || trigger.retry.maxAttempts <= 1) return undefined;
  return trigger.retry;
}

export function defaultRetryOn(action: Action | undefined): string[] {
  if (!action) return [];
  if (action.kind === "http") return HTTP_RETRY_ON;
  if (action.kind === "honeybee") return HIVE_RETRY_ON;
  if (action.kind === "sequence") return [...new Set(action.actions.flatMap((step) => defaultRetryOn(step.action)))];
  return [];
}

export function retryDelayMs(policy: RetryPolicy, attempt: number, retryAfterMs?: number, random = Math.random): number {
  const maxBackoff = parseDuration(policy.maxBackoff);
  if (retryAfterMs !== undefined) return Math.min(Math.max(0, retryAfterMs), maxBackoff);
  const base = Math.min(parseDuration(policy.backoff) * 2 ** (attempt - 1), maxBackoff);
  const jittered = base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * random());
  return Math.round(Math.min(jittered, maxBackoff));
}

type AttemptFailure = {
  attempt: number;
  startedAt: string;
  error: unknown;
  forceRetryable?: boolean;
  timedOut?: { result: ActionResult; warnings: string[]; durationMs?: number };
};

export class ActionExecutor {
  constructor(
    private readonly store: PollinateStore,
    private readonly options: ActionExecutorOptions,
  ) {}

  async createQueuedJob(trigger: Trigger, activation: Activation, batch: JsonValue[]): Promise<Job> {
    const identity = await this.store.allocateJobIdentity(trigger);
    return {
      id: identity.id,
      idPrefix: identity.idPrefix,
      uuid: identity.uuid,
      triggerId: trigger.id,
      deliveryId: withDeliveryId(activation).metadata?.deliveryId,
      source: activation.source,
      status: "queued",
      cwd: trigger.cwd,
      context: {},
      action: trigger.action,
      queuedAt: nowIso(),
      batch,
    };
  }

  async dryRun(trigger: Trigger, incoming: Activation, batch: JsonValue[] = [incoming.payload]): Promise<DryRunResult> {
    const activation = withDeliveryId(incoming);
    if (trigger.router && !trigger.action) {
      return {
        triggerId: trigger.id,
        cwd: trigger.cwd,
        context: {
          trigger_id: trigger.id,
          source_kind: activation.source,
          event: JSON.stringify(activation.payload),
          batch: JSON.stringify(batch),
          batch_count: String(batch.length),
          delivery_id: activation.metadata?.deliveryId ?? "",
        },
        action: trigger.router.onOpen,
        warnings: ["Router dry-run renders the configured onOpen action only; it does not normalize or route events."],
      };
    }
    const resolved = await this.buildContext(trigger, activation, batch, trigger.cwd, { jobId: "dry-run", attempt: FIRST_ATTEMPT });
    if (!trigger.action) throw new Error(`Trigger ${trigger.id} has no action`);
    const rendered = this.renderJobInputs(trigger.action, trigger.cwd, resolved.context);
    return {
      triggerId: trigger.id,
      cwd: rendered.cwd,
      context: resolved.context,
      action: rendered.action,
      warnings: [...resolved.warnings, ...rendered.warnings],
    };
  }

  async executeJob(job: Job, trigger: Trigger, incoming: Activation, batch: JsonValue[]): Promise<Job> {
    const activation = job.deliveryId && !incoming.metadata?.deliveryId
      ? { ...incoming, metadata: { ...incoming.metadata, deliveryId: job.deliveryId } }
      : withDeliveryId(incoming);
    const fresh = await this.store.getJob(job.id);
    if (fresh?.status === "cancelled") return fresh;
    const attempt = (fresh?.attempt ?? 0) + 1;
    return withHiveStartingObserver(this.hiveStartingObserver(job), () =>
      trigger.router && !job.action
        ? this.executeRouterJob(job, trigger, activation, batch, attempt)
        : this.executePlainJob(job, trigger, activation, batch, attempt),
    );
  }

  async interruptAttempt(job: Job, trigger: Trigger): Promise<Job> {
    const attempt = job.attempt ?? FIRST_ATTEMPT;
    const startedAt = job.attempts?.length ? job.attempts[job.attempts.length - 1]!.endedAt : (job.startedAt ?? job.queuedAt);
    return this.failAttempt(job, trigger, {
      attempt,
      startedAt,
      error: new ActionFailure(`daemon restarted mid-execution during attempt ${attempt}`, ["interrupted"]),
      forceRetryable: true,
    });
  }

  private hiveStartingObserver(job: Job): HiveStartingObserver {
    return {
      onRefused: async (refusal) => {
        const refusedAt = nowIso();
        const previous = (await this.store.getJob(job.id))?.hiveStarting;
        await this.store.updateJob(job.id, {
          hiveStarting: {
            refusals: (previous?.refusals ?? 0) + 1,
            firstRefusedAt: previous?.firstRefusedAt ?? refusedAt,
            lastRefusedAt: refusedAt,
            lastCommand: refusal.label,
            lastMessage: refusal.message,
          },
        });
        await this.store.appendLedger({
          event: "pollinate.job.hive_starting",
          job_id: job.id,
          trigger_id: job.triggerId,
          command: refusal.label,
          attempt: refusal.attempt,
          waited_ms: refusal.waitedMs,
          retry_in_ms: refusal.retryInMs,
          ...(refusal.phase ? { phase: refusal.phase } : {}),
          message: refusal.message,
        });
      },
      shouldStop: async () => ((await this.store.getJob(job.id))?.status === "cancelled" ? "job cancelled" : undefined),
    };
  }

  private async executePlainJob(job: Job, trigger: Trigger, activation: Activation, batch: JsonValue[], attempt: number): Promise<Job> {
    const attemptStartedAt = nowIso();
    const resolving = await this.store.updateJob(job.id, { status: "resolving-context", attempt, nextAttemptAt: undefined });
    if (resolving.status === "cancelled") return resolving;
    try {
      const jobCwd = job.cwd ?? trigger.cwd;
      const execution = this.executionContextFor(job, trigger, activation, attempt);
      const resolved = await this.buildContext(trigger, activation, batch, jobCwd, execution);
      if (!job.action) throw new Error(`Job ${job.id} has no action`);
      const rendered = this.renderJobInputs(job.action, jobCwd, resolved.context);
      const warnings = resolved.warnings.concat(rendered.warnings);
      const running = await this.store.updateJob(job.id, {
        status: "running",
        cwd: rendered.cwd,
        context: resolved.context,
        action: rendered.action,
        startedAt: resolving.startedAt ?? attemptStartedAt,
      });
      await this.store.appendLedger({
        event: "pollinate.job.started",
        job_id: job.id,
        trigger_id: trigger.id,
        action_kind: rendered.action.kind,
        cwd: rendered.cwd,
        ...(attempt > FIRST_ATTEMPT ? { attempt } : {}),
      });
      const result = await this.executeAction(rendered.action, rendered.cwd, execution);
      const durationMs = running.startedAt ? Date.now() - new Date(running.startedAt).getTime() : undefined;
      if (result.timedOut) {
        return this.failAttempt(job, trigger, {
          attempt,
          startedAt: attemptStartedAt,
          error: new ActionFailure("action timed out", ["timeout"]),
          timedOut: { result, warnings, durationMs },
        });
      }
      const completed = await this.store.updateJob(job.id, {
        status: "completed",
        result,
        completedAt: nowIso(),
        error: warnings.join("\n") || undefined,
        attempts: appendAttempt(running.attempts, { attempt, startedAt: attemptStartedAt, endedAt: nowIso(), retryable: false }),
      });
      await this.store.appendLedger({
        event: "pollinate.job.completed",
        job_id: job.id,
        trigger_id: trigger.id,
        duration_ms: durationMs,
        warnings,
        ...(attempt > FIRST_ATTEMPT ? { attempt } : {}),
      });
      return completed;
    } catch (error) {
      return this.failAttempt(job, trigger, { attempt, startedAt: attemptStartedAt, error });
    }
  }

  private async failAttempt(job: Job, trigger: Trigger, failure: AttemptFailure): Promise<Job> {
    const { attempt, startedAt, error, timedOut } = failure;
    const message = error instanceof Error ? error.message : String(error);
    const policy = retryPolicyFor(trigger);
    const codes = error instanceof ActionFailure ? error.codes : [];
    const retryOn = policy ? (policy.on ?? defaultRetryOn(job.action ?? trigger.action)) : [];
    const retryable = Boolean(policy) && (failure.forceRetryable === true || retryOn.some((code) => codes.includes(code)));
    const current = await this.store.getJob(job.id);
    if (current?.status === "cancelled") return current;
    const attempts = appendAttempt(current?.attempts, { attempt, startedAt, endedAt: nowIso(), error: message, retryable });
    if (policy && retryable && attempt < policy.maxAttempts) {
      const delayMs = retryDelayMs(policy, attempt, error instanceof ActionFailure ? error.retryAfterMs : undefined);
      const firstStartedAt = new Date(attempts[0]?.startedAt ?? startedAt).getTime();
      const elapsedAtNextAttempt = Date.now() + delayMs - (Number.isNaN(firstStartedAt) ? Date.now() : firstStartedAt);
      if (elapsedAtNextAttempt <= parseDuration(policy.maxElapsed)) {
        const retrying = await this.store.updateJob(job.id, {
          status: "retrying",
          attempt,
          error: message,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          attempts,
        });
        if (retrying.status !== "retrying") return retrying;
        await this.store.appendLedger({
          event: "pollinate.job.retry_scheduled",
          job_id: job.id,
          trigger_id: trigger.id,
          delivery_id: job.deliveryId,
          attempt,
          retry_in_ms: delayMs,
          error: message,
        });
        return retrying;
      }
    }
    const gaveUp = retryable;
    const errored = await this.store.updateJob(job.id, {
      status: timedOut ? "timed-out" : "errored",
      attempt,
      nextAttemptAt: undefined,
      completedAt: nowIso(),
      attempts,
      ...(timedOut ? { result: timedOut.result, error: timedOut.warnings.join("\n") || undefined } : { error: message }),
    });
    await this.store.appendLedger({
      event: "pollinate.job.errored",
      job_id: job.id,
      trigger_id: trigger.id,
      ...(timedOut ? { duration_ms: timedOut.durationMs, warnings: timedOut.warnings } : { error: message }),
      attempts: attempt,
      gave_up: gaveUp,
    });
    return errored;
  }

  private async executeRouterJob(job: Job, trigger: Trigger, activation: Activation, batch: JsonValue[], attempt: number): Promise<Job> {
    const execution = this.executionContextFor(job, trigger, activation, attempt);
    const running = await this.store.updateJob(job.id, {
      status: "running",
      attempt,
      cwd: job.cwd ?? trigger.cwd,
      context: {
        event: JSON.stringify(activation.payload),
        batch: JSON.stringify(batch),
        batch_count: String(batch.length),
        delivery_id: execution.deliveryId,
      },
      startedAt: nowIso(),
    });
    await this.store.appendLedger({ event: "pollinate.job.started", job_id: job.id, trigger_id: trigger.id, action_kind: "router", cwd: running.cwd });
    try {
      const result = await executeRouter({
        store: this.store,
        executor: this,
        trigger,
        activation,
        cwd: running.cwd,
        execution,
      });
      const completed = await this.store.updateJob(job.id, { status: "completed", result, completedAt: nowIso() });
      await this.store.appendLedger({
        event: "pollinate.job.completed",
        job_id: job.id,
        trigger_id: trigger.id,
        duration_ms: running.startedAt ? Date.now() - new Date(running.startedAt).getTime() : undefined,
        warnings: [],
      });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errored = await this.store.updateJob(job.id, { status: "errored", error: message, completedAt: nowIso() });
      await this.store.appendLedger({ event: "pollinate.job.errored", job_id: job.id, trigger_id: trigger.id, error: message, attempts: attempt, gave_up: false });
      return errored;
    }
  }

  private executionContextFor(job: Job, trigger: Trigger, activation: Activation, attempt: number): ActionExecutionContext {
    return {
      triggerId: trigger.id,
      deliveryId: job.deliveryId ?? activation.metadata?.deliveryId ?? deliveryIdFor(trigger.id, `job:${job.uuid ?? job.id}`),
      jobId: job.id,
      attempt,
    };
  }

  private async buildContext(trigger: Trigger, activation: Activation, batch: JsonValue[], cwd: string | undefined, execution: Pick<ActionExecutionContext, "jobId" | "attempt">) {
    const resolved = await resolveContext(trigger, activation, {
      defaultTimeoutMs: this.options.contextTimeoutMs,
      cwd,
      jobId: execution.jobId,
      attempt: execution.attempt,
      deliveryIds: activationDeliveryIds(activation),
      execution: this.options.execution,
      hiveStartingWaitMs: this.hiveStartingWaitMs,
    });
    return {
      context: {
        ...resolved.context,
        batch: JSON.stringify(batch),
        batch_count: String(batch.length),
      },
      warnings: resolved.warnings,
    };
  }

  private renderJobInputs(action: Action, cwd: string | undefined, context: Record<string, string>): { action: Action; cwd?: string; warnings: string[] } {
    const renderedAction = renderAction(action, context);
    const renderedCwd = cwd ? renderString(cwd, context) : { value: undefined, warnings: [] };
    return {
      action: renderedAction.value,
      cwd: renderedCwd.value,
      warnings: [...renderedAction.warnings, ...renderedCwd.warnings],
    };
  }

  async executeAction(action: Action, cwd?: string, executionContext?: ActionExecutionContext): Promise<ActionResult> {
    if (action.kind === "sequence") {
      return this.executeSequence(action, cwd, executionContext);
    }
    if (action.kind === "command") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const result = await execShell(action.command, { cwd: action.cwd ?? cwd, timeoutMs, execution: this.options.execution });
      if (result.timedOut) return { ...result, timedOut: true };
      if (result.exitCode !== 0) throw new ActionFailure(`command exited ${result.exitCode}: ${result.stderr.trim()}`, ["exit", `exit:${result.exitCode}`]);
      return { ...result };
    }
    if (action.kind === "http") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        let body: string;
        try {
          response = await fetch(action.url, {
            method: action.method,
            headers: withDeliveryHeaders(action.headers, executionContext),
            body: action.body,
            signal: controller.signal,
          });
          body = await response.text();
        } catch (error) {
          throw new ActionFailure(error instanceof Error ? error.message : String(error), [controller.signal.aborted ? "timeout" : "transport"]);
        }
        if (!response.ok) {
          throw new ActionFailure(
            `HTTP ${response.status}: ${body.slice(0, 500)}`,
            [`status:${response.status}`, `status:${Math.floor(response.status / 100)}xx`],
            parseRetryAfterMs(response.headers.get("retry-after")),
          );
        }
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    }
    if (action.kind === "honeybee") {
      return this.executeHoneybee(action, cwd, executionContext);
    }
    if (action.kind === "emit") {
      let payload: JsonValue | string | undefined = action.payload;
      if (action.payload) {
        try {
          payload = JSON.parse(action.payload) as JsonValue;
        } catch {
          payload = action.payload;
        }
      }
      await this.store.appendLedger({ event: "pollinate.emit", subject: action.subject, payload });
      return { subject: action.subject, payload };
    }
    const neverAction: never = action;
    throw new Error(`Unsupported action: ${JSON.stringify(neverAction)}`);
  }

  private async executeSequence(
    action: Extract<Action, { kind: "sequence" }>,
    cwd?: string,
    executionContext?: ActionExecutionContext,
  ): Promise<ActionResult> {
    const continueOnError = action.continueOnError === true;
    const runStep = async (step: (typeof action.actions)[number], index: number) => {
      const id = step.id ?? String(index + 1);
      try {
        const stepContext = executionContext
          ? { ...executionContext, deliveryId: `${executionContext.deliveryId}.s${index + 1}` }
          : undefined;
        const result = await this.executeAction(step.action, cwd, stepContext);
        return { id, action: step.action.kind, result };
      } catch (error) {
        if (!continueOnError) throw error;
        return { id, action: step.action.kind, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const results =
      action.mode === "parallel"
        ? await Promise.all(action.actions.map((step, index) => runStep(step, index)))
        : await runSequence(action.actions, runStep);
    const handles: Record<string, string> = {};
    for (const step of results) {
      const result = "result" in step ? step.result : undefined;
      if (!result) continue;
      if (typeof result.handle === "string") handles[step.id] = result.handle;
      if (result.handles) {
        for (const [key, value] of Object.entries(result.handles)) handles[key] = value;
      }
    }
    const handle = (action.primary ? handles[action.primary] : undefined) ?? Object.values(handles)[0];
    const primaryResult = action.primary
      ? results.find((step) => step.id === action.primary)
      : results.find((step) => "result" in step && typeof step.result?.runId === "string");
    const primaryActionResult = primaryResult && "result" in primaryResult ? primaryResult.result : undefined;
    const runId = primaryActionResult && typeof primaryActionResult.runId === "string"
      ? primaryActionResult.runId
      : undefined;
    return {
      results,
      ...(Object.keys(handles).length ? { handles } : {}),
      ...(handle ? { handle } : {}),
      ...(runId ? { runId } : {}),
    };
  }

  private async executeHoneybee(
    action: Extract<Action, { kind: "honeybee" }>,
    cwd?: string,
    executionContext?: ActionExecutionContext,
  ): Promise<ActionResult> {
    if (action.run === "spawn") {
      const spawnCwd = action.cwd ?? cwd;
      // v2 grammar (cutover 2026-08-19): name is positional, harness is
      // --agent, colonies become tags, a home IS an account id, and --yolo
      // maps to the harness's own bypass flag as a per-bee arg (kept across
      // revives).
      const name = action.name ?? `pol-${(executionContext?.deliveryId ?? Date.now().toString(36)).replace(/[^A-Za-z0-9._:-]+/g, "-")}`;
      const v2Args = ["spawn", name, "--agent", action.bee, "--json"];
      if (spawnCwd) v2Args.push("--cwd", spawnCwd);
      if (action.colony) v2Args.push("--tag", `colony=${action.colony}`);
      if (action.home) v2Args.push("--account", action.home);
      const bypass = action.yolo === true ? HARNESS_BYPASS_ARGS[action.bee] : undefined;
      for (const beeArg of [...(bypass ?? []), ...(action.args ?? [])]) v2Args.push("--arg", beeArg);
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(v2Args, "hive spawn", { cwd: spawnCwd, timeoutMs }).then(async (result) => {
        const handle = parseV2SpawnBeeId(result.stdout) ?? (isValidHiveHandle(action.name) ? action.name : undefined);
        if (!handle) {
          throw new Error(`hive spawn did not return a parsable target handle; stdout: ${JSON.stringify(String(result.stdout).slice(0, 200))}`);
        }
        if (action.message) {
          const sent = await this.execHive(["send", handle, action.message], "hive send", { cwd: spawnCwd, timeoutMs });
          return { ...result, handle, sent };
        }
        return { ...result, handle };
      });
    }
    if (action.run === "send") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(["send", action.target, action.message], "hive send", { cwd, timeoutMs });
    }
    if (action.run === "kill") {
      // v2 split kill into stop (end the process; the bee stays revivable)
      // and delete (irreversible purge). Automation must never purge records:
      // kill maps to stop.
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(["stop", action.target], "hive stop", { cwd, timeoutMs });
    }
    const neverAction: never = action;
    throw new Error(`Unsupported honeybee action: ${JSON.stringify(neverAction)}`);
  }

  private get hiveStartingWaitMs(): number {
    return this.options.hiveStartingWaitMs ?? DEFAULT_HIVE_STARTING_WAIT_MS;
  }

  private async execHive(args: string[], label: string, options: { cwd?: string; timeoutMs?: number }): Promise<ActionResult & ExecResult> {
    const result = await execHive(args, {
      label,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.options.commandTimeoutMs,
      execution: this.options.execution,
      startingWaitMs: this.hiveStartingWaitMs,
    });
    if (result.exitCode !== 0) throw new ActionFailure(`${label} exited ${result.exitCode}: ${result.stderr.trim()}`, hiveFailureCodes(result));
    return { ...result };
  }

}

/** Build an ActionExecutor from the store's daemon config (timeouts + shell). */
export async function createExecutor(store: PollinateStore): Promise<ActionExecutor> {
  const config = await store.daemonConfig();
  return new ActionExecutor(store, {
    contextTimeoutMs: parseDuration(config.defaults.contextTimeout, 5_000),
    commandTimeoutMs: parseDuration(config.defaults.commandTimeout, 600_000),
    hiveStartingWaitMs: parseDuration(config.defaults.hiveStartingWait, DEFAULT_HIVE_STARTING_WAIT_MS),
    execution: config.execution,
  });
}

/**
 * Fire a trigger immediately with the given payload: queue a job, ledger it, run
 * it to completion, and return the terminal job. Shared by `pol trigger` and tests — so the manual-fire path lives
 * in one place. `executor` may be injected to reuse a configured instance.
 */
export async function fireTriggerNow(
  store: PollinateStore,
  trigger: Trigger,
  payload: JsonValue = {},
  options: { executor?: ActionExecutor; source?: SourceKind; deliveryId?: string } = {},
): Promise<Job> {
  const executor = options.executor ?? (await createExecutor(store));
  const activation = manualActivation(trigger, payload, options);
  if (!(await admitDelivery(store, activation))) throw new DuplicateDeliveryError(activation.metadata?.deliveryId ?? "");
  const job = await executor.createQueuedJob(trigger, activation, [payload]);
  await store.saveJob(job);
  await store.appendLedger({ event: "pollinate.job.queued", job_id: job.id, trigger_id: trigger.id, queue_position: 0, at: nowIso() });
  let current = await executor.executeJob(job, trigger, activation, [payload]);
  while (current.status === "retrying") {
    const dueAt = current.nextAttemptAt ? new Date(current.nextAttemptAt).getTime() : Date.now();
    await sleep(Math.max(0, (Number.isNaN(dueAt) ? Date.now() : dueAt) - Date.now()));
    current = await executor.executeJob(job, trigger, activation, [payload]);
  }
  return current;
}

export class DuplicateDeliveryError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Delivery ${deliveryId} was already fired; not firing again`);
  }
}

export function manualActivation(trigger: Trigger, payload: JsonValue, options: { source?: SourceKind; deliveryId?: string } = {}): Activation {
  const activation: Activation = { triggerId: trigger.id, source: options.source ?? "manual", payload, receivedAt: nowIso() };
  if (!options.deliveryId) return withDeliveryId(activation);
  return { ...activation, metadata: { deliveryId: deliveryIdFor(trigger.id, options.deliveryId), stableDeliveryId: true } };
}

async function runSequence<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += 1) out.push(await fn(items[index]!, index));
  return out;
}

/** Old --yolo, per harness: the bypass flag rides as a per-bee arg in v2. */
const HARNESS_BYPASS_ARGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
};

/**
 * v2 `hive spawn --json` prints one JSON object with the bee's canonical id.
 * (The old first-token scrape would happily return the word "spawned" from
 * v2's human output — silently wrong, hence the explicit JSON contract.)
 */
export function parseV2SpawnBeeId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { beeId?: unknown };
      if (typeof parsed.beeId === "string" && parsed.beeId.length > 0) return parsed.beeId;
    } catch {
      // not a JSON line; keep scanning
    }
  }
  return undefined;
}

const HIVE_HANDLE_RE = /^[A-Za-z0-9._:-]+$/;

export function isValidHiveHandle(value: string | undefined): value is string {
  // The trailing-colon exclusion skips prefix lines like "warning:" or "Error:".
  return Boolean(value && HIVE_HANDLE_RE.test(value) && !value.endsWith(":"));
}

export function sourceKindForTrigger(trigger: Trigger, fallback: SourceKind = "manual"): SourceKind {
  return trigger.source.kind === "manual" ? fallback : trigger.source.kind;
}

export function withDeliveryHeaders(headers: Record<string, string> | undefined, execution?: ActionExecutionContext): Record<string, string> | undefined {
  if (!execution) return headers;
  const merged: Record<string, string> = { ...(headers ?? {}) };
  const present = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
  const defaults: Record<string, string> = {
    "Idempotency-Key": execution.deliveryId,
    "X-Pollinate-Delivery": execution.deliveryId,
    "X-Pollinate-Trigger": execution.triggerId,
    "X-Pollinate-Attempt": String(execution.attempt),
  };
  for (const [key, value] of Object.entries(defaults)) if (!present.has(key.toLowerCase())) merged[key] = value;
  return merged;
}

function appendAttempt(previous: JobAttempt[] | undefined, record: JobAttempt): JobAttempt[] {
  return [...(previous ?? []), record].slice(-MAX_ATTEMPT_RECORDS);
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function hiveFailureCodes(result: ExecResult): string[] {
  const codes = new Set<string>();
  if (result.timedOut) codes.add("timeout");
  for (const match of result.stderr.matchAll(/\berror \(([a-z][a-z0-9_]*)\)/g)) codes.add(match[1]!);
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const code = (JSON.parse(trimmed) as { error?: { code?: unknown } }).error?.code;
      if (typeof code === "string") codes.add(code);
    } catch {
      continue;
    }
  }
  return [...codes];
}
