import { ActionExecutor, executorOptionsFor, manualActivation } from "./actions.js";
import { ApiError, ApiServer, type ApiHost } from "./api.js";
import { DEFAULT_DAEMON_CONFIG } from "./config.js";
import { probeHive, triggerUsesHive } from "./hive-exec.js";
import { DeliveryManager } from "./delivery.js";
import { PollEngine, type PollCheck } from "./poll.js";
import { ScheduleEngine } from "./schedule.js";
import { PollinateStore } from "./store.js";
import { WebhookServer } from "./webhook.js";
import { nowIso, parseDuration } from "./time.js";
import {
  acquireDaemonLock,
  apiSocketPath,
  appendTextLine,
  ensureStoreSchema,
  DAEMON_LOCK_HEARTBEAT_MS,
  daemonLockPath,
  daemonLogPath,
  refreshDaemonLock,
  releaseDaemonLock,
  rotateLedgerIfLarge,
  type DaemonLock,
  type DaemonLockHolder,
} from "./fsx.js";
import { gcTemporaryHooks } from "./hooks.js";
import { DEFAULT_BINDING_RETENTION, gcRouterBindings, routerGcSummary } from "./router-gc.js";
import { TriggerHealthMonitor } from "./health.js";
import { jobStoreWarnings, recordDaemonStart, recordDaemonStop, topTriggersByFiles, writeJobStoreHealth } from "./daemon-health.js";
import { readBuildCommit } from "./build-info.js";
import { realpath } from "node:fs/promises";
import { TriggerTagIndex } from "./events.js";
import type { DaemonConfig, Job, JobStatus, JsonValue, Trigger } from "./types.js";

const STALE_JOB_RECOVERY_MS = 60_000;
const NON_TERMINAL_JOB_STATUSES: JobStatus[] = ["queued", "resolving-context", "running", "retrying"];
const MS_PER_DAY = 86_400_000;
const MIN_PRESSURE_GC_SPACING_MS = 60_000;
let daemonProcessGuardsInstalled = false;

export class DaemonRefusedError extends Error {
  constructor(
    readonly reason: "locked" | "lock_lost",
    readonly holderPid: number | null,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRefusedError";
  }
}

export class PollinateDaemon {
  onLockLost?: (error: DaemonRefusedError) => void;
  private lock?: DaemonLock;
  private lockHeartbeatTimer?: NodeJS.Timeout;
  private delivery?: DeliveryManager;
  private schedule?: ScheduleEngine;
  private poll?: PollEngine;
  private webhook?: WebhookServer;
  private executor?: ActionExecutor;
  private health?: TriggerHealthMonitor;
  private config?: DaemonConfig;
  private triggers: Trigger[] = [];
  readonly eventTags: TriggerTagIndex;
  private triggerById = new Map<string, Trigger>();
  private reloadTimer?: NodeJS.Timeout;
  private bindingGcTimer?: NodeJS.Timeout;
  private bindingGcRunning = false;
  private jobsGcTimer?: NodeJS.Timeout;
  private jobsGcRunning = false;
  private jobsGcLastStartedAt = 0;
  private jobsGcPressureTimer?: NodeJS.Timeout;
  private jobsAllocatedSinceGc = new Map<string, number>();
  private jobsAllocatedTotalSinceGc = 0;
  private triggerSignature = "";
  private stopping = false;
  private daemonConfigSignature = "";
  private api?: ApiServer;
  private triggerQueue: Promise<unknown> = Promise.resolve();
  private reloadQueued = false;
  private startedAt = nowIso();
  private reloadedAt = this.startedAt;
  private hiveStatus?: { path: string; version: string | null } | null;
  private hiveProbing?: Promise<void>;

  constructor(private readonly store = new PollinateStore()) {
    this.eventTags = TriggerTagIndex.forStore(store.root, (id) => store.getTrigger(id));
  }

  async start(): Promise<void> {
    await this.store.ensure();
    await this.acquireLock();
    try {
      await ensureStoreSchema(this.store.root);
      const api = new ApiServer(this.apiHost(), apiSocketPath(this.store.root));
      await api.prepare();
      this.api = api;
      await this.startEngines();
      await this.startApi(api);
    } catch (error) {
      await this.log(`daemon start failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.abandonStart();
      throw error;
    }
  }

  private async acquireLock(): Promise<void> {
    const attempt = await acquireDaemonLock(this.store.root);
    if (!attempt.acquired) {
      const holderPid = attempt.holder?.pid ?? null;
      await this.store.appendLedger({ event: "pollinate.daemon.refused", reason: "locked", pid: holderPid });
      const message = `store ${this.store.root} is locked by daemon pid ${holderPid ?? "unknown"}${describeHolder(attempt.holder)} (${daemonLockPath(this.store.root)})`;
      await this.log(`daemon start refused (pid ${process.pid}): ${message}`);
      throw new DaemonRefusedError("locked", holderPid, message);
    }
    this.lock = attempt.lock;
    this.lockHeartbeatTimer = setInterval(() => {
      void this.heartbeatLock();
    }, DAEMON_LOCK_HEARTBEAT_MS);
    this.lockHeartbeatTimer.unref?.();
  }

  private async heartbeatLock(): Promise<void> {
    const lock = this.lock;
    if (!lock || this.stopping) return;
    try {
      const check = await refreshDaemonLock(lock);
      if (check.held || this.lock !== lock) return;
      this.lock = undefined;
      const holderPid = check.holder?.pid ?? null;
      await this.store.appendLedger({ event: "pollinate.daemon.refused", reason: "lock_lost", pid: holderPid });
      const message = `daemon pid ${process.pid} lost the store lock to pid ${holderPid ?? "unknown"}${describeHolder(check.holder)}; stopping`;
      await this.log(message);
      await this.stop();
      this.onLockLost?.(new DaemonRefusedError("lock_lost", holderPid, message));
    } catch (error) {
      await this.log(`daemon lock heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async abandonStart(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    this.health?.shutdown();
    await this.api?.stop().catch(() => undefined);
    await this.webhook?.stop().catch(() => undefined);
    await this.poll?.stop().catch(() => undefined);
    await this.schedule?.stop().catch(() => undefined);
    await this.delivery?.shutdown().catch(() => undefined);
    await this.releaseLock();
  }

  private async releaseLock(): Promise<void> {
    if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer);
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await releaseDaemonLock(lock).catch(() => undefined);
  }

  private async startEngines(): Promise<void> {
    const restarts = await recordDaemonStart(this.store.root).catch(() => ({ uncleanExits: 0, crashLoop: false }));
    if (restarts.crashLoop) {
      await this.store.appendLedger({ event: "pollinate.daemon.crash_loop", unclean_exits: restarts.uncleanExits });
      await this.log(`WARNING crash loop: ${restarts.uncleanExits} unclean daemon exits in the last hour`);
    } else if (restarts.uncleanExits > 0) {
      await this.log(`previous daemon run exited uncleanly (${restarts.uncleanExits} unclean exits in the last hour)`);
    }
    const startedAtMs = Date.now();
    this.startedAt = new Date(startedAtMs).toISOString();
    this.reloadedAt = this.startedAt;
    const config = await this.store.daemonConfig();
    await gcTemporaryHooks(this.store);
    await this.pruneOrphanedTriggerState();
    const { triggers, invalid } = await this.store.loadTriggerFiles();
    const executor = new ActionExecutor(this.store, executorOptionsFor(config));
    this.config = config;
    this.store.onJobAllocated = (triggerId) => this.noteJobAllocated(triggerId);
    this.daemonConfigSignature = signatureForConfig(config);
    this.executor = executor;
    await this.eventTags.load().catch((error) => this.log(`event tag index load failed: ${error instanceof Error ? error.message : String(error)}`));
    this.setTriggers(triggers);
    this.health = new TriggerHealthMonitor(this.store, executor, {
      defaults: config.defaults.onFailure,
      triggerFor: (triggerId) => this.triggerById.get(triggerId),
    });
    executor.health = this.health;
    await this.health.load();
    this.delivery = new DeliveryManager(this.store, executor, this.health);
    await this.delivery.init(triggers);
    await this.recoverStaleJobsAtStartup(startedAtMs);
    this.webhook = new WebhookServer(this.store, this.delivery, triggers, config.webhook.bind, config.webhook.port, config.webhook.relay);
    await this.webhook.start();
    this.schedule = new ScheduleEngine(this.store, this.delivery, triggers, config.defaults.tickMs, this.health);
    this.poll = new PollEngine(this.store, this.delivery, triggers, config.execution, this.health);
    await this.schedule.start();
    await this.poll.start();
    await this.health.syncTriggerFiles(triggers, invalid);
    this.triggerSignature = signatureForTriggers(triggers);
    this.reloadTimer = setInterval(() => {
      void this.reloadTriggers();
    }, config.defaults.triggerReloadMs);
    this.bindingGcTimer = setInterval(() => {
      void this.runBindingGc();
    }, config.defaults.bindingGcMs);
    this.jobsGcTimer = setInterval(() => {
      void this.runJobsGc();
    }, config.retention.jobsGcMs);
    const build = await readBuildCommit();
    await this.store.appendLedger({
      event: "pollinate.daemon.started",
      pid: process.pid,
      entry: process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : null,
      commit: build?.commit ?? null,
      dirty: build?.dirty ?? null,
      trigger_count: triggers.length,
      webhook_bind: config.webhook.bind,
      webhook_port: config.webhook.port,
      webhook_relay_enabled: Boolean(config.webhook.relay.secret),
      socket: apiSocketPath(this.store.root),
    });
    await this.log(
      `daemon started in ${Date.now() - startedAtMs}ms: ${triggers.length} triggers, webhook ${config.webhook.bind}:${config.webhook.port}, binding gc every ${config.defaults.bindingGcMs}ms, jobs gc every ${config.retention.jobsGcMs}ms`,
    );
    void this.runBindingGc();
    void this.runJobsGc("startup");
    if (triggers.some(triggerUsesHive)) void this.probeHive(config);
  }

  private probeHive(config: DaemonConfig): Promise<void> {
    this.hiveProbing ??= this.runHiveProbe(config);
    return this.hiveProbing;
  }

  private async runHiveProbe(config: DaemonConfig): Promise<void> {
    const probe = await probeHive(config.honeybee.bin, config.execution);
    this.hiveStatus = probe.path ? { path: probe.path, version: probe.version } : null;
    await this.store.appendLedger({ event: "pollinate.hive.probed", ...probe });
    if (!probe.ok) await this.log(`hive probe failed for ${probe.path ?? config.honeybee.bin ?? "hive"}: ${probe.error ?? "unknown error"}`);
  }

  private async pruneOrphanedTriggerState(): Promise<void> {
    try {
      const pruned = await this.store.pruneOrphanedTriggerState();
      if (pruned.entries > 0) await this.log(`startup prune removed ${pruned.entries} state entries of removed triggers`);
    } catch (error) {
      await this.log(`startup state prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async recoverStaleJobsAtStartup(startedAtMs: number): Promise<void> {
    try {
      await this.recoverStaleJobs(startedAtMs);
    } catch (error) {
      await this.log(`stale job recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.api?.beginStopping();
    this.clearTimers();
    this.health?.shutdown();
    await this.webhook?.stop();
    await this.poll?.stop();
    await this.schedule?.stop();
    await this.delivery?.shutdown();
    await this.api?.stop().catch(() => undefined);
    await this.store.appendLedger({ event: "pollinate.daemon.stopped" });
    await recordDaemonStop(this.store.root).catch(() => undefined);
    await this.releaseLock();
    await this.log("daemon stopped");
  }

  private clearTimers(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.bindingGcTimer) clearInterval(this.bindingGcTimer);
    if (this.jobsGcTimer) clearInterval(this.jobsGcTimer);
    if (this.jobsGcPressureTimer) clearTimeout(this.jobsGcPressureTimer);
    this.store.onJobAllocated = undefined;
  }

  private serially<T>(step: () => Promise<T>): Promise<T> {
    const run = this.triggerQueue.then(step, step);
    this.triggerQueue = run.catch(() => undefined);
    return run;
  }

  private async reloadTriggers(): Promise<void> {
    if (this.reloadQueued) return;
    this.reloadQueued = true;
    await this.serially(async () => {
      this.reloadQueued = false;
      await this.reloadTriggersNow();
    });
  }

  private async pushTriggersToEngines(): Promise<void> {
    if (!this.delivery || !this.schedule || !this.poll || !this.webhook) return;
    this.webhook.updateTriggers(this.triggers);
    await this.delivery.init(this.triggers);
    await this.schedule.applyNow(this.triggers);
    this.poll.updateTriggers(this.triggers);
  }

  private async reloadTriggersNow(): Promise<void> {
    if (this.stopping || !this.delivery || !this.schedule || !this.poll || !this.webhook) return;
    try {
      const config = await this.store.daemonConfig();
      const configSignature = signatureForConfig(config);
      if (configSignature !== this.daemonConfigSignature) {
        this.daemonConfigSignature = configSignature;
        await this.log("pollinate.toml changed; restart the daemon to apply webhook, defaults, relay, or execution-profile changes");
      }
      await gcTemporaryHooks(this.store, { hasLiveJobs: (triggerId) => this.delivery?.hasLiveJobs(triggerId) ?? false });
      const { triggers, invalid } = await this.store.loadTriggerFiles();
      const signature = signatureForTriggers(triggers);
      if (signature === this.triggerSignature) {
        await this.health?.syncTriggerFiles(triggers, invalid);
        return;
      }
      this.triggerSignature = signature;
      this.setTriggers(triggers);
      this.reloadedAt = nowIso();
      await this.health?.syncTriggerFiles(triggers, invalid);
      await this.pushTriggersToEngines();
      await this.store.appendLedger({ event: "pollinate.daemon.triggers_reloaded", trigger_count: triggers.length });
      await this.log(`triggers reloaded: ${triggers.length} active definitions`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.appendLedger({
        event: "pollinate.daemon.reload_errored",
        error: message,
      });
      await this.log(`trigger reload failed: ${message}`);
    }
  }

  private async startApi(api: ApiServer): Promise<void> {
    await api.start();
    await this.log(`api listening on ${api.socketPath}`);
  }

  private apiHost(): ApiHost {
    const daemon = this;
    return {
      store: this.store,
      get startedAt() {
        return daemon.startedAt;
      },
      get reloadedAt() {
        return daemon.reloadedAt;
      },
      config: () => this.config ?? DEFAULT_DAEMON_CONFIG,
      webhookAddress: () => this.webhook?.address() ?? null,
      triggers: () => this.triggers,
      trigger: (id) => this.triggerById.get(id),
      preflightPoll: (trigger) => this.requirePoll().preflight(trigger),
      applyTrigger: (id, write, fetchedPoll) => this.applyTrigger(id, write, fetchedPoll),
      scheduleState: (id) => this.schedule?.stateFor(id) ?? {},
      fire: (trigger, payload, deliveryId) => this.fireTrigger(trigger, payload, deliveryId),
      hive: () => this.hive(),
    };
  }

  private requirePoll(): PollEngine {
    if (!this.poll) throw new Error("poll engine is not running");
    return this.poll;
  }

  private async applyTrigger<T extends Trigger | null>(id: string, write: () => Promise<T>, fetchedPoll?: string): Promise<{ stored: T; poll?: PollCheck }> {
    const applied = await this.serially(async () => {
      const { poll } = this;
      if (this.stopping || !this.delivery || !this.schedule || !poll || !this.webhook) throw new ApiError("stopping", "the daemon is stopping");
      const stored = await write();
      const triggers = this.triggers.filter((trigger) => trigger.id !== id);
      if (stored) triggers.push(stored);
      triggers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.setTriggers(triggers);
      this.triggerSignature = signatureForTriggers(triggers);
      this.reloadedAt = nowIso();
      const checksPoll = stored !== null && fetchedPoll !== undefined && stored.enabled && stored.source.kind === "poll";
      const check = checksPoll ? poll.adoptChecked(this.triggers, stored, fetchedPoll) : undefined;
      check?.catch(() => undefined);
      await this.pushTriggersToEngines();
      return { stored, check };
    });
    if (!applied.check) return { stored: applied.stored };
    return { stored: applied.stored, poll: await applied.check };
  }

  private async fireTrigger(trigger: Trigger, payload: JsonValue, deliveryId?: string): Promise<{ job: Job | null; duplicate: boolean }> {
    if (!this.delivery) throw new Error("delivery is not running");
    const activation = manualActivation(trigger, payload, { deliveryId });
    const fullDeliveryId = activation.metadata?.deliveryId;
    if (deliveryId && fullDeliveryId && (await this.store.hasSeenDelivery(trigger.id, fullDeliveryId))) {
      await this.store.appendLedger({ event: "pollinate.delivery.duplicate", trigger_id: trigger.id, delivery_id: fullDeliveryId, source: activation.source });
      return { job: null, duplicate: true };
    }
    return { job: await this.delivery.handle(trigger, activation), duplicate: false };
  }

  private hive(): { path: string; version: string | null } | undefined {
    if (this.config) void this.probeHive(this.config);
    return this.hiveStatus ?? undefined;
  }

  private setTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
    this.triggerById = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    void this.eventTags.observe(triggers).catch((error) => this.log(`event tag index update failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async runBindingGc(): Promise<void> {
    if (this.stopping || this.bindingGcRunning || !this.executor) return;
    this.bindingGcRunning = true;
    try {
      const result = await gcRouterBindings({
        store: this.store,
        executor: this.executor,
        triggers: this.triggers,
        execution: this.config?.execution,
        health: this.health,
        bindingRetentionMs: parseDuration(this.config?.router.bindingRetention ?? DEFAULT_BINDING_RETENTION),
      });
      const summary = routerGcSummary(result);
      if (summary) {
        await this.store.appendLedger({
          event: "pollinate.router.gc",
          expired: result.expired,
          reconciled: result.reconciled,
          retried: result.retried,
          retry_failed: result.retryFailed,
          abandoned: result.abandoned,
          staled: result.staled,
          close_retried: result.closeRetried,
          close_retry_failed: result.closeRetryFailed,
          close_abandoned: result.closeAbandoned,
          pruned: result.pruned,
          errors: result.errors,
        });
        await this.log(`binding gc: ${summary}`);
      }
    } catch (error) {
      await this.log(`binding gc failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.bindingGcRunning = false;
    }
  }

  private noteJobAllocated(triggerId: string): void {
    const retention = this.config?.retention;
    if (!retention || this.stopping) return;
    const count = (this.jobsAllocatedSinceGc.get(triggerId) ?? 0) + 1;
    this.jobsAllocatedSinceGc.set(triggerId, count);
    this.jobsAllocatedTotalSinceGc += 1;
    const triggerPressure = retention.jobsMaxPerTrigger > 0 && count >= Math.max(1, Math.floor(retention.jobsMaxPerTrigger / 2));
    const totalPressure = retention.jobsMaxTotal > 0 && this.jobsAllocatedTotalSinceGc >= Math.max(1, Math.floor(retention.jobsMaxTotal / 4));
    if ((!triggerPressure && !totalPressure) || this.jobsGcPressureTimer) return;
    const reason = triggerPressure
      ? `${triggerId} created ${count}+ jobs since the last sweep`
      : `${this.jobsAllocatedTotalSinceGc}+ jobs created since the last sweep`;
    const delay = Math.max(0, this.jobsGcLastStartedAt + MIN_PRESSURE_GC_SPACING_MS - Date.now());
    this.jobsGcPressureTimer = setTimeout(() => {
      this.jobsGcPressureTimer = undefined;
      void this.runJobsGc(reason);
    }, delay);
  }

  private async runJobsGc(reason?: string): Promise<void> {
    if (this.stopping || this.jobsGcRunning || !this.config) return;
    this.jobsGcRunning = true;
    this.jobsGcLastStartedAt = Date.now();
    this.jobsAllocatedSinceGc.clear();
    this.jobsAllocatedTotalSinceGc = 0;
    try {
      const retention = this.config.retention;
      const terminalOlderThanDays = parseDuration(retention.jobsMaxAge) / MS_PER_DAY;
      const result = await this.store.garbageCollectJobs({
        terminalOlderThanDays,
        keepLastPerTrigger: retention.jobsKeepLastPerTrigger,
        maxPerTrigger: retention.jobsMaxPerTrigger,
        maxTotal: retention.jobsMaxTotal,
      });
      const topTriggers = topTriggersByFiles(
        Object.fromEntries(Object.entries(result.perTrigger).map(([id, bucket]) => [id, { files: bucket.kept }])),
      );
      const warnings = jobStoreWarnings(result.kept, result.keptBytes, retention, topTriggers);
      await writeJobStoreHealth(this.store.root, {
        checkedAt: nowIso(),
        files: result.kept,
        bytes: result.keptBytes,
        deleted: result.deleted,
        topTriggers,
        warnings,
      });
      if (result.deleted > 0) {
        await this.store.appendLedger({
          event: "pollinate.jobs.gc",
          deleted: result.deleted,
          deleted_by_cap: result.deletedByCap,
          kept: result.kept,
          kept_bytes: result.keptBytes,
          cutoff: result.cutoff,
          pruned_job_uuids: result.prunedJobUuids,
        });
      }
      await this.log(
        `jobs store: ${result.kept} files, ${formatMb(result.keptBytes)}; gc removed ${result.deleted} (${result.deletedByCap} over the ${retention.jobsMaxPerTrigger}/trigger or ${retention.jobsMaxTotal} total cap, rest older than ${result.cutoff})${reason ? `; reason: ${reason}` : ""}`,
      );
      for (const warning of warnings) {
        await this.store.appendLedger({ event: "pollinate.jobs.store_warning", warning, files: result.kept, bytes: result.keptBytes });
        await this.log(`WARNING ${warning}`);
      }
      const generation = await rotateLedgerIfLarge(this.store.root, retention.ledgerMaxMb);
      if (generation !== false) {
        await this.store.appendLedger({ event: "pollinate.ledger.rotated", max_mb: retention.ledgerMaxMb, generation });
        await this.log(`ledger rotated: exceeded ${retention.ledgerMaxMb}MB, moved to ledger.jsonl.1`);
      }
    } catch (error) {
      await this.log(`jobs gc failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.jobsGcRunning = false;
    }
  }

  private async log(message: string): Promise<void> {
    try {
      await appendTextLine(daemonLogPath(this.store.root), `${nowIso()} ${message}`);
    } catch {
      // Logging must never take the daemon down.
    }
  }

  async logProcessGuard(message: string): Promise<void> {
    await this.log(`process guard: ${message}`);
  }

  private async recoverStaleJobs(now = Date.now(), staleMs = STALE_JOB_RECOVERY_MS): Promise<number> {
    const jobs = await this.store.listJobs({ statuses: NON_TERMINAL_JOB_STATUSES });
    let recovered = 0;
    for (const listed of jobs) {
      try {
        if (this.delivery?.ownsJob(listed.id) || this.health?.ownsNotification(listed.id)) continue;
        const job = await this.store.getJob(listed.id);
        if (!job || !NON_TERMINAL_JOB_STATUSES.includes(job.status)) continue;
        const notification = job.source === "failure";
        const touchedAt = job.nextAttemptAt ?? job.startedAt ?? job.queuedAt;
        const touchedMs = new Date(touchedAt).getTime();
        if (!notification && Number.isFinite(touchedMs) && now - touchedMs < staleMs) continue;
        if (await this.delivery?.adoptOrphan(job)) {
          recovered += 1;
          continue;
        }
        const previousStatus = job.status;
        const error = `daemon restarted mid-execution; marking stale ${previousStatus} job errored`;
        const updated = await this.store.updateJob(job.id, { status: "errored", error, completedAt: nowIso() }, { onlyFrom: NON_TERMINAL_JOB_STATUSES });
        if (updated.status !== "errored" || updated.error !== error) continue;
        await this.store.appendLedger({
          event: "pollinate.job.errored",
          job_id: job.id,
          trigger_id: job.triggerId,
          error,
          recovered_from: previousStatus,
        });
        if (notification) {
          await this.health?.notificationInterrupted(job, error);
        } else if (job.action) {
          await this.health?.recordFailure(job.triggerId, { kind: "job", error, jobId: job.id, deliveryId: job.deliveryId });
        }
        recovered += 1;
      } catch (error) {
        await this.log(`stale job recovery failed for ${listed.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (recovered > 0) await this.log(`recovered ${recovered} stale non-terminal jobs`);
    return recovered;
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function describeHolder(holder: DaemonLockHolder | null): string {
  if (!holder) return "";
  return `, started ${holder.startedAt ?? "unknown"}, heartbeat ${holder.heartbeatAt}`;
}

function signatureForTriggers(triggers: Array<{ id: string; updatedAt: string; enabled: boolean }>): string {
  return triggers
    .map((trigger) => `${trigger.id}:${trigger.updatedAt}:${trigger.enabled}`)
    .sort()
    .join("|");
}

function signatureForConfig(config: DaemonConfig): string {
  return JSON.stringify(config);
}

export async function runForeground(onFatal: (error: unknown) => void): Promise<void> {
  const daemon = new PollinateDaemon();
  installDaemonProcessGuards((message) => daemon.logProcessGuard(message));
  daemon.onLockLost = onFatal;
  await daemon.start();
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
}

function installDaemonProcessGuards(log: (message: string) => Promise<void>): void {
  if (daemonProcessGuardsInstalled) return;
  daemonProcessGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const message = `unhandled rejection: ${formatUnknownError(reason)}`;
    console.error(`pollinate daemon ${message}`);
    void log(message).catch(() => undefined);
  });
  process.on("uncaughtException", (error) => {
    const message = `uncaught exception: ${formatUnknownError(error)}`;
    console.error(`pollinate daemon ${message}`);
    void log(message).catch(() => undefined);
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
