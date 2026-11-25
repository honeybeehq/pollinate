import http from "node:http";
import { describe, expect, test } from "vitest";
import { ActionExecutor } from "../src/actions.js";
import { parseDaemonConfigToml, parseTriggerToml, triggerToToml } from "../src/config.js";
import { DeliveryManager } from "../src/delivery.js";
import { FAILURE_ERROR_MAX_CHARS, notificationDue, resolveOnFailure, TriggerHealthMonitor, type HealthRecorder, type TriggerFailure } from "../src/health.js";
import { PollEngine, pollDelayMs } from "../src/poll.js";
import { closeBinding } from "../src/router.js";
import { gcRouterBindings } from "../src/router-gc.js";
import type { PollinateStore } from "../src/store.js";
import type { Activation, Job, OnFailurePolicy, RetryPolicy, RouterBinding, Trigger } from "../src/types.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

const FAST_RETRY: RetryPolicy = { maxAttempts: 3, backoff: "20ms", maxBackoff: "50ms", maxElapsed: "10s" };

function executor(store: PollinateStore): ActionExecutor {
  return new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 2000 });
}

function monitorFor(store: PollinateStore, triggers: Trigger[], defaults?: OnFailurePolicy): TriggerHealthMonitor {
  const byId = new Map(triggers.map((item) => [item.id, item]));
  return new TriggerHealthMonitor(store, executor(store), { defaults, triggerFor: (id) => byId.get(id), notificationRetry: FAST_RETRY });
}

function activation(trig: Trigger): Activation {
  return { triggerId: trig.id, source: "manual", payload: {}, receivedAt: new Date().toISOString() };
}

async function ledgerEvents(store: PollinateStore, event: string): Promise<Array<Record<string, unknown>>> {
  return (await store.readLedger()).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}

async function notificationJobs(store: PollinateStore): Promise<Job[]> {
  return (await store.listJobs()).filter((job) => job.source === "failure");
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withServer(statuses: number[], fn: (url: string, bodies: string[]) => Promise<void>): Promise<void> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(statuses[Math.min(bodies.length - 1, statuses.length - 1)]!);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/notify`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const EMIT_NOTIFY: OnFailurePolicy = {
  action: { kind: "emit", subject: "failed", payload: '{"id":"{{trigger_id}}","name":"{{trigger_name}}","kind":"{{failure_kind}}","error":"{{failure_error}}","job":"{{failed_job_id}}","delivery":"{{delivery_id}}","n":"{{consecutive_failures}}","since":"{{first_failed_at}}"}' },
};

function failingCommand(id = "broken", overrides: Partial<Trigger> = {}): Trigger {
  return trigger({ id, name: `${id} name`, action: { kind: "command", command: "echo nope >&2; exit 3" }, ...overrides });
}

describe("onFailure config", () => {
  test("parses camelCase and snake_case keys, round-trips, and stays absent by default", () => {
    const camel = parseTriggerToml(`[trigger]\nid = "a"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.onFailure]\nafter = 3\ncooldown = "30s"\ndisabled = false\n[trigger.onFailure.action]\nkind = "http"\nurl = "http://127.0.0.1:1/x"\n`);
    expect(camel.onFailure).toEqual({ after: 3, cooldown: "30s", disabled: false, action: { kind: "http", method: "POST", url: "http://127.0.0.1:1/x", headers: undefined, body: undefined, timeout: undefined } });
    expect(parseTriggerToml(triggerToToml(camel)).onFailure).toEqual(camel.onFailure);
    const snake = parseTriggerToml(`[trigger]\nid = "b"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.on_failure]\ndisabled = true\n`);
    expect(snake.onFailure).toEqual({ disabled: true });
    expect(parseTriggerToml(`[trigger]\nid = "c"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n`).onFailure).toBeUndefined();
    expect(() => parseTriggerToml(`[trigger]\nid = "d"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.onFailure]\nafter = 0\n`)).toThrow(/after/);
    expect(() => parseTriggerToml(`[trigger]\nid = "e"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.onFailure]\ncooldown = "soon"\n`)).toThrow(/Invalid duration/);
  });

  test("reads [defaults.onFailure] and [defaults.on_failure] from pollinate.toml", () => {
    expect(parseDaemonConfigToml(`[defaults.onFailure]\ncooldown = "5m"\n[defaults.onFailure.action]\nkind = "emit"\nsubject = "f"\n`).defaults.onFailure).toEqual({ cooldown: "5m", action: { kind: "emit", subject: "f", payload: undefined } });
    expect(parseDaemonConfigToml(`[defaults.on_failure]\nafter = 2\n`).defaults.onFailure).toEqual({ after: 2 });
    expect(parseDaemonConfigToml(`[defaults]\ntickMs = 500\n`).defaults.onFailure).toBeUndefined();
  });

  test("a trigger's own onFailure overrides the default key by key, and disabled turns it off", () => {
    const action = { kind: "emit" as const, subject: "x" };
    expect(resolveOnFailure(undefined, undefined)).toBeUndefined();
    expect(resolveOnFailure(undefined, { action })).toEqual({ after: 1, cooldownMs: 3_600_000, action });
    expect(resolveOnFailure({ after: 3 }, { action, cooldown: "5m" })).toEqual({ after: 3, cooldownMs: 300_000, action });
    expect(resolveOnFailure({ disabled: true }, { action })).toBeUndefined();
    expect(resolveOnFailure({ after: 2 }, undefined)).toBeUndefined();
  });

  test("notifies at `after` failures and then once per cooldown within one failing streak", () => {
    const policy = { after: 2, cooldownMs: 60_000, action: { kind: "emit" as const, subject: "x" } };
    const t0 = Date.parse("2026-11-25T10:00:00.000Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    expect(notificationDue({ consecutiveFailures: 1, firstFailedAt: at(0) }, policy, t0)).toBe(false);
    expect(notificationDue({ consecutiveFailures: 2, firstFailedAt: at(0) }, policy, t0 + 1_000)).toBe(true);
    expect(notificationDue({ consecutiveFailures: 3, firstFailedAt: at(0), notifiedAt: at(1_000) }, policy, t0 + 30_000)).toBe(false);
    expect(notificationDue({ consecutiveFailures: 4, firstFailedAt: at(0), notifiedAt: at(1_000) }, policy, t0 + 61_000)).toBe(true);
    expect(notificationDue({ consecutiveFailures: 2, firstFailedAt: at(5_000), notifiedAt: at(1_000) }, policy, t0 + 6_000)).toBe(true);
  });
});

describe("trigger health", () => {
  test("a failing job records health, notifies once per cooldown with the failure vars, and recovery is ledgered", async () => {
    await withTempStore(async (store) => {
      const trig = failingCommand("broken", { onFailure: { ...EMIT_NOTIFY, cooldown: "1h" } });
      const monitor = monitorFor(store, [trig]);
      const delivery = new DeliveryManager(store, executor(store), monitor);
      await delivery.init([trig]);

      await delivery.handle(trig, activation(trig));
      await delivery.handle(trig, activation(trig));
      const jobs = await waitForTerminalJobs(store, 2);
      await waitFor(() => ledgerEvents(store, "pollinate.trigger.failed"), (events) => events.length === 2);
      await monitor.idle();

      const failed = await ledgerEvents(store, "pollinate.trigger.failed");
      expect(failed.map((event) => event.consecutive)).toEqual([1, 2]);
      expect(failed[0]).toMatchObject({ trigger_id: "broken", kind: "job", error: "command exited 3: nope" });
      expect(jobs.map((job) => job.id)).toContain(failed[0]!.job_id);
      expect(String(failed[0]!.delivery_id)).toMatch(/^broken:manual:/);

      const notes = await notificationJobs(store);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ triggerId: "broken", source: "failure", status: "completed" });
      const emitted = await ledgerEvents(store, "pollinate.emit");
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload).toEqual({
        id: "broken",
        name: "broken name",
        kind: "job",
        error: "command exited 3: nope",
        job: failed[0]!.job_id,
        delivery: failed[0]!.delivery_id,
        n: "1",
        since: (await store.readTriggerHealth()).broken!.firstFailedAt,
      });

      const health = (await store.readTriggerHealth()).broken!;
      expect(health).toMatchObject({ consecutiveFailures: 2, lastFailureKind: "job", lastError: "command exited 3: nope" });
      expect(health.notifiedAt).toBe(health.firstFailedAt);

      await monitor.recordSuccess("broken", "job");
      expect((await store.readTriggerHealth()).broken).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: expect.any(String) });
      expect(await ledgerEvents(store, "pollinate.trigger.recovered")).toEqual([
        expect.objectContaining({ trigger_id: "broken", kind: "job", consecutive: 2, first_failed_at: health.firstFailedAt }),
      ]);

      await monitor.recordFailure("broken", { kind: "job", error: "again" });
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(2);
    });
  });

  test("a second notification goes out only after the cooldown", async () => {
    await withTempStore(async (store) => {
      const trig = failingCommand("cool", { onFailure: { ...EMIT_NOTIFY, cooldown: "300ms" } });
      const monitor = monitorFor(store, [trig]);
      await monitor.recordFailure("cool", { kind: "poll", error: "poll HTTP 500" });
      await monitor.recordFailure("cool", { kind: "poll", error: "poll HTTP 500" });
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await monitor.recordFailure("cool", { kind: "poll", error: "poll HTTP 500" });
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(2);
      expect((await ledgerEvents(store, "pollinate.emit")).map((event) => (event.payload as Record<string, string>).n)).toEqual(["1", "3"]);
    });
  });

  test("the daemon default applies to triggers without onFailure; `after` waits for that many failures", async () => {
    await withTempStore(async (store) => {
      const trig = failingCommand("plain");
      const monitor = monitorFor(store, [trig], { ...EMIT_NOTIFY, after: 2 });
      await monitor.recordFailure("plain", { kind: "job", error: "one" });
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(0);
      await monitor.recordFailure("plain", { kind: "job", error: "two" });
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(1);
      expect((await ledgerEvents(store, "pollinate.emit"))[0]!.payload).toMatchObject({ error: "two", n: "2" });
    });
  });

  test("without onFailure and without a default, failures are recorded but nothing is sent", async () => {
    await withTempStore(async (store) => {
      const trig = failingCommand("quiet");
      const monitor = monitorFor(store, [trig]);
      const delivery = new DeliveryManager(store, executor(store), monitor);
      await delivery.init([trig]);
      await delivery.handle(trig, activation(trig));
      await waitFor(() => ledgerEvents(store, "pollinate.trigger.failed"), (events) => events.length === 1);
      await monitor.idle();
      expect(await notificationJobs(store)).toHaveLength(0);
      expect((await store.readTriggerHealth()).quiet?.consecutiveFailures).toBe(1);
    });
  });

  test("a retrying job is not a failure until its retries run out", async () => {
    await withServer([503, 503, 200], async (url) => {
      await withTempStore(async (store) => {
        const trig = trigger({ id: "flaky", action: { kind: "http", method: "POST", url }, retry: FAST_RETRY, onFailure: EMIT_NOTIFY });
        const monitor = monitorFor(store, [trig]);
        const delivery = new DeliveryManager(store, executor(store), monitor);
        await delivery.init([trig]);
        await delivery.handle(trig, activation(trig));
        const [job] = await waitForTerminalJobs(store, 1);
        expect(job).toMatchObject({ status: "completed", attempt: 3 });
        await waitFor(() => store.readTriggerHealth(), (health) => Boolean(health.flaky?.lastSuccessAt));
        expect(await ledgerEvents(store, "pollinate.trigger.failed")).toHaveLength(0);
        expect((await store.readTriggerHealth()).flaky?.consecutiveFailures).toBe(0);
      });
    });
  });

  test("the notification retries three times and ledgers on_failure_errored when it cannot be delivered", async () => {
    await withServer([503, 503, 200], async (url, bodies) => {
      await withTempStore(async (store) => {
        const trig = failingCommand("retry-ok", { onFailure: { action: { kind: "http", method: "POST", url, body: "{{event}}" } } });
        const monitor = monitorFor(store, [trig]);
        await monitor.recordFailure("retry-ok", { kind: "job", error: "x".repeat(FAILURE_ERROR_MAX_CHARS + 500) });
        await monitor.idle();
        const [note] = await notificationJobs(store);
        expect(note).toMatchObject({ status: "completed", attempt: 3 });
        expect(bodies).toHaveLength(3);
        expect((JSON.parse(bodies[2]!) as Record<string, string>).failure_error).toHaveLength(FAILURE_ERROR_MAX_CHARS);
        expect(await ledgerEvents(store, "pollinate.trigger.on_failure_errored")).toHaveLength(0);
      });
    });
    await withServer([500], async (url, bodies) => {
      await withTempStore(async (store) => {
        const trig = failingCommand("retry-bad", { onFailure: { action: { kind: "http", method: "POST", url } } });
        const monitor = monitorFor(store, [trig]);
        await monitor.recordFailure("retry-bad", { kind: "job", error: "boom" });
        await monitor.idle();
        expect(bodies).toHaveLength(3);
        const [errored] = await ledgerEvents(store, "pollinate.trigger.on_failure_errored");
        expect(errored).toMatchObject({ trigger_id: "retry-bad", attempts: 3, error: expect.stringContaining("HTTP 500") });
        expect((await store.readTriggerHealth())["retry-bad"]?.consecutiveFailures).toBe(1);
        expect(await ledgerEvents(store, "pollinate.trigger.failed")).toHaveLength(1);
      });
    });
  });

  test("a poll check success recovers poll failures but not job failures", async () => {
    await withTempStore(async (store) => {
      const trig = failingCommand("poller");
      const monitor = monitorFor(store, [trig]);
      await monitor.recordFailure("poller", { kind: "job", error: "job broke" });
      await monitor.recordSuccess("poller", "poll");
      expect((await store.readTriggerHealth()).poller?.consecutiveFailures).toBe(1);
      await monitor.recordFailure("poller", { kind: "poll", error: "fetch broke" });
      await monitor.recordSuccess("poller", "poll");
      expect((await store.readTriggerHealth()).poller?.consecutiveFailures).toBe(0);
      expect(await ledgerEvents(store, "pollinate.trigger.recovered")).toEqual([expect.objectContaining({ kind: "poll", consecutive: 2 })]);
    });
  });

  test("an invalid trigger file is reported once per error and recovers when it loads again", async () => {
    await withTempStore(async (store) => {
      const fixed = failingCommand("bad-file");
      const live: Trigger[] = [];
      const byId = () => new Map(live.map((item) => [item.id, item]));
      const monitor = new TriggerHealthMonitor(store, executor(store), { defaults: EMIT_NOTIFY, triggerFor: (id) => byId().get(id), notificationRetry: FAST_RETRY });
      const invalid = [{ id: "bad-file", path: "/x/bad-file.toml", error: "Unsupported action kind: buzz" }];
      await monitor.syncTriggerFiles([], invalid);
      await monitor.syncTriggerFiles([], invalid);
      await monitor.idle();
      expect(await ledgerEvents(store, "pollinate.trigger.failed")).toEqual([expect.objectContaining({ trigger_id: "bad-file", kind: "invalid", consecutive: 1 })]);
      expect((await ledgerEvents(store, "pollinate.emit"))[0]!.payload).toMatchObject({ id: "bad-file", name: "bad-file", kind: "invalid" });
      live.push(fixed);
      await monitor.syncTriggerFiles(live, []);
      expect(await ledgerEvents(store, "pollinate.trigger.recovered")).toEqual([expect.objectContaining({ trigger_id: "bad-file", kind: "invalid" })]);
    });
  });

  test("health entries follow the trigger: removed on `pol remove` and pruned for missing files", async () => {
    await withTempStore(async (store) => {
      const kept = failingCommand("kept");
      const gone = failingCommand("gone");
      await store.saveTrigger(kept);
      await store.saveTrigger(gone);
      const monitor = monitorFor(store, [kept, gone]);
      await monitor.recordFailure("kept", { kind: "job", error: "x" });
      await monitor.recordFailure("gone", { kind: "job", error: "x" });
      await store.updateTriggerHealth("orphan", () => ({ consecutiveFailures: 1 }));
      await store.removeTrigger("gone");
      expect(Object.keys(await store.readTriggerHealth()).sort()).toEqual(["kept", "orphan"]);
      expect((await store.pruneOrphanedTriggerState()).files["trigger-health.json"]).toEqual({ before: 2, after: 1 });
      expect(Object.keys(await store.readTriggerHealth())).toEqual(["kept"]);
    });
  });
});

describe("poll backoff", () => {
  test("doubles the interval per failure after three in a row, up to 16 times", () => {
    expect([0, 1, 2, 3, 4, 5].map((errors) => pollDelayMs(1_000, errors))).toEqual([1_000, 1_000, 1_000, 2_000, 4_000, 8_000]);
    expect(pollDelayMs(1_000, 18)).toBe(1_000 * 2 ** 16);
    expect(pollDelayMs(1_000, 40)).toBe(1_000 * 2 ** 16);
  });

  test("ledgers the backoff on poll.errored, records poll failures, and returns to the interval on success", async () => {
    await withTempStore(async (store, root) => {
      const flag = `${root}/ok`;
      const trig = trigger({
        id: "poll-flaky",
        source: { kind: "poll", poll: { interval: "40ms", emit: "per-poll", fetch: { kind: "command", command: `test -f '${flag}' && echo '[]' || { echo down >&2; exit 1; }` }, cursor: { strategy: "hash" } } },
      });
      const monitor = monitorFor(store, [trig]);
      const delivery = new DeliveryManager(store, executor(store), monitor);
      await delivery.init([trig]);
      const poll = new PollEngine(store, delivery, [trig], undefined, monitor);
      await poll.start();
      try {
        const errored = await waitFor(() => ledgerEvents(store, "pollinate.poll.errored"), (events) => events.length >= 4);
        expect(errored.slice(0, 4).map((event) => [event.consecutive_errors, event.next_check_in_ms])).toEqual([[1, 40], [2, 40], [3, 80], [4, 160]]);
        await import("node:fs/promises").then((fs) => fs.writeFile(flag, ""));
        await waitFor(() => ledgerEvents(store, "pollinate.trigger.recovered"), (events) => events.length === 1, 5_000);
        expect((await ledgerEvents(store, "pollinate.trigger.failed")).every((event) => event.kind === "poll")).toBe(true);
        const checkedAfter = (await ledgerEvents(store, "pollinate.poll.checked")).length;
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await ledgerEvents(store, "pollinate.poll.checked")).length).toBeGreaterThan(checkedAfter + 2);
      } finally {
        await poll.stop();
      }
    });
  });
});

describe("router failure points", () => {
  function recorder(): HealthRecorder & { failures: Array<TriggerFailure & { triggerId: string }> } {
    const failures: Array<TriggerFailure & { triggerId: string }> = [];
    return {
      failures,
      async recordFailure(triggerId, failure) {
        failures.push({ triggerId, ...failure });
      },
      async recordSuccess() {},
    };
  }

  function routerTrigger(): Trigger {
    return trigger({
      id: "rt",
      source: { kind: "webhook", webhook: { path: "rt" } },
      action: undefined,
      router: {
        plugin: "github-pr",
        openOn: ["github.pull_request.opened"],
        closeOn: ["github.pull_request.merged"],
        onOpen: { kind: "emit", subject: "open" },
        onActivity: { kind: "emit", subject: "activity" },
      },
    });
  }

  function binding(overrides: Partial<RouterBinding> = {}): RouterBinding {
    const now = new Date().toISOString();
    return { id: "rt.s", triggerId: "rt", router: "github-pr", subjectKey: "s", status: "active", target: { kind: "hive", handle: "bee" }, createdAt: now, updatedAt: now, ...overrides };
  }

  test("a failing onClose records router_close and still throws", async () => {
    await withTempStore(async (store) => {
      const health = recorder();
      const trig = routerTrigger();
      const failing = { executeAction: async () => Promise.reject(new Error("hive stop exited 1: gone")) };
      await expect(
        closeBinding({ store, executor: failing, trigger: trig, health }, trig.router!, { subjectKey: "s", kind: "github.pull_request.merged", payload: {} }, binding()),
      ).rejects.toThrow("gone");
      expect(health.failures).toEqual([{ triggerId: "rt", kind: "router_close", error: "hive stop exited 1: gone", deliveryId: undefined }]);
    });
  });

  test("an errored binding abandoned after its open retries records router_open", async () => {
    await withTempStore(async (store) => {
      const health = recorder();
      const trig = routerTrigger();
      await store.saveRouterBinding(binding({ status: "errored", target: undefined, openAttempts: 4, context: { pr_number: 5 }, error: "hive spawn exited 1" }));
      const result = await gcRouterBindings({ store, executor: executor(store), triggers: [trig], health });
      expect(result.abandoned).toEqual(["rt.s"]);
      expect(health.failures).toEqual([{ triggerId: "rt", kind: "router_open", error: "hive spawn exited 1" }]);
    });
  });
});
