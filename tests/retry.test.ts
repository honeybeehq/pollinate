import http from "node:http";
import { describe, expect, test } from "vitest";
import { ActionExecutor, fireTriggerNow, hiveFailureCodes, parseRetryAfterMs, retryDelayMs } from "../src/actions.js";
import { parseTriggerToml } from "../src/config.js";
import { DeliveryManager } from "../src/delivery.js";
import type { Activation, Job, RetryPolicy, Trigger } from "../src/types.js";
import type { PollinateStore } from "../src/store.js";
import { trigger, waitForJobs, waitForTerminalJobs, withTempStore } from "./helpers.js";

type Hit = { key?: string; attempt?: string };

async function withServer(statuses: Array<number | { status: number; headers?: Record<string, string> }>, fn: (url: string, hits: Hit[]) => Promise<void>): Promise<void> {
  const hits: Hit[] = [];
  const server = http.createServer((request, response) => {
    hits.push({ key: request.headers["idempotency-key"] as string, attempt: request.headers["x-pollinate-attempt"] as string });
    const next = statuses[Math.min(hits.length - 1, statuses.length - 1)]!;
    const spec = typeof next === "number" ? { status: next } : next;
    response.writeHead(spec.status, spec.headers ?? {});
    response.end(String(spec.status));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await fn(`http://127.0.0.1:${address.port}/hook`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function executor(store: PollinateStore): ActionExecutor {
  return new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 2000 });
}

function retry(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { maxAttempts: 5, backoff: "20ms", maxBackoff: "100ms", maxElapsed: "1m", ...overrides };
}

function httpTrigger(url: string, overrides: Partial<Trigger> = {}): Trigger {
  return trigger({ id: "hook", action: { kind: "http", method: "POST", url, body: "{}" }, ...overrides });
}

function activation(trig: Trigger, payload = {}): Activation {
  return { triggerId: trig.id, source: "manual", payload, receivedAt: new Date().toISOString() };
}

async function ledgerEvents(store: PollinateStore, event: string): Promise<Array<Record<string, unknown>>> {
  return (await store.readLedger()).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}

async function waitForStatus(store: PollinateStore, id: string, status: Job["status"], timeoutMs = 3_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const job = await store.getJob(id);
    if (job?.status === status) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${id} to be ${status}; it is ${job?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForInFlight(store: PollinateStore, triggerId: string, count: number, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (((await store.readDeliveryState())[triggerId]?.inFlight ?? []).length !== count) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${count} in-flight entries`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("retry policy config", () => {
  test("parses camelCase and snake_case keys and keeps retry off by default", () => {
    const camel = parseTriggerToml(`[trigger]\nid = "a"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.retry]\nmaxAttempts = 8\nbackoff = "2s"\nmaxBackoff = "5m"\nmaxElapsed = "1h"\non = ["transport", "status:5xx"]\n[trigger.delivery]\nmaxQueued = 5\n`);
    expect(camel.retry).toEqual({ maxAttempts: 8, backoff: "2s", maxBackoff: "5m", maxElapsed: "1h", on: ["transport", "status:5xx"] });
    expect(camel.delivery.maxQueued).toBe(5);
    const snake = parseTriggerToml(`[trigger]\nid = "b"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.retry]\nmax_attempts = 3\nmax_backoff = "10s"\nmax_elapsed = "2m"\n[trigger.delivery]\nmax_queued = 7\n`);
    expect(snake.retry).toEqual({ maxAttempts: 3, backoff: "2s", maxBackoff: "10s", maxElapsed: "2m" });
    expect(snake.delivery.maxQueued).toBe(7);
    const plain = parseTriggerToml(`[trigger]\nid = "c"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n`);
    expect(plain.retry).toBeUndefined();
    expect(plain.delivery.maxQueued).toBeUndefined();
  });

  test("rejects unknown retry classes", () => {
    expect(() => parseTriggerToml(`[trigger]\nid = "a"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n[trigger.retry]\nmaxAttempts = 2\non = ["status:9xx"]\n`)).toThrow(/unsupported entry/);
  });

  test("backoff doubles with jitter, caps at maxBackoff and honours Retry-After up to it", () => {
    const policy = retry({ backoff: "1s", maxBackoff: "5s" });
    expect(retryDelayMs(policy, 1, undefined, () => 0.5)).toBe(1000);
    expect(retryDelayMs(policy, 2, undefined, () => 0)).toBe(1600);
    expect(retryDelayMs(policy, 2, undefined, () => 1)).toBe(2400);
    expect(retryDelayMs(policy, 6, undefined, () => 1)).toBe(5000);
    expect(retryDelayMs(policy, 1, 3000)).toBe(3000);
    expect(retryDelayMs(policy, 1, 60_000)).toBe(5000);
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });

  test("hive failures expose their error codes", () => {
    expect(hiveFailureCodes({ exitCode: 1, signal: null, stdout: "", stderr: "error (hived_handover_stalled): stuck", timedOut: false })).toEqual(["hived_handover_stalled"]);
    expect(hiveFailureCodes({ exitCode: 1, signal: null, stdout: '{"error":{"code":"socket_unreachable"}}', stderr: "", timedOut: false })).toEqual(["socket_unreachable"]);
    expect(hiveFailureCodes({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true })).toEqual(["timeout"]);
  });
});

describe("durable retry", () => {
  test("http 5xx is retried with one Idempotency-Key until it succeeds", async () => {
    await withTempStore(async (store) => {
      await withServer([503, 502, 200], async (url, hits) => {
        const trig = httpTrigger(url, { retry: retry() });
        const job = await fireTriggerNow(store, trig, {}, { executor: executor(store) });
        expect(job.status).toBe("completed");
        expect(job.attempt).toBe(3);
        expect(job.attempts?.map((item) => item.retryable)).toEqual([true, true, false]);
        expect(new Set(hits.map((hit) => hit.key))).toEqual(new Set([job.deliveryId]));
        expect(hits.map((hit) => hit.attempt)).toEqual(["1", "2", "3"]);
        const scheduled = await ledgerEvents(store, "pollinate.job.retry_scheduled");
        expect(scheduled.map((entry) => entry.attempt)).toEqual([1, 2]);
        expect(scheduled[0]).toMatchObject({ job_id: job.id, trigger_id: "hook", delivery_id: job.deliveryId, error: "HTTP 503: 503" });
      });
    });
  });

  test("without a retry policy a failure errors after one attempt", async () => {
    await withTempStore(async (store) => {
      await withServer([503, 200], async (url, hits) => {
        const job = await fireTriggerNow(store, httpTrigger(url), {}, { executor: executor(store) });
        expect(job.status).toBe("errored");
        expect(hits).toHaveLength(1);
        expect((await ledgerEvents(store, "pollinate.job.errored"))[0]).toMatchObject({ attempts: 1, gave_up: false });
      });
    });
  });

  test("other 4xx are final and exhausted attempts give up", async () => {
    await withTempStore(async (store) => {
      await withServer([404], async (url, hits) => {
        const job = await fireTriggerNow(store, httpTrigger(url, { retry: retry() }), {}, { executor: executor(store) });
        expect(job.status).toBe("errored");
        expect(hits).toHaveLength(1);
      });
      await withServer([500], async (url, hits) => {
        const job = await fireTriggerNow(store, httpTrigger(url, { id: "hook2", retry: retry({ maxAttempts: 2 }) }), {}, { executor: executor(store) });
        expect(job.status).toBe("errored");
        expect(hits).toHaveLength(2);
      });
      expect((await ledgerEvents(store, "pollinate.job.errored")).map((entry) => [entry.attempts, entry.gave_up])).toEqual([
        [1, false],
        [2, true],
      ]);
    });
  });

  test("maxElapsed stops retrying", async () => {
    await withTempStore(async (store) => {
      await withServer([{ status: 429, headers: { "retry-after": "1" } }, 200], async (url, hits) => {
        const job = await fireTriggerNow(store, httpTrigger(url, { retry: retry({ maxBackoff: "2s", maxElapsed: "500ms" }) }), {}, { executor: executor(store) });
        expect(job.status).toBe("errored");
        expect(hits).toHaveLength(1);
      });
    });
  });

  test("commands retry only when on contains exit", async () => {
    await withTempStore(async (store) => {
      const failing = { kind: "command" as const, command: "exit 3" };
      const once = await fireTriggerNow(store, trigger({ id: "cmd", action: failing, retry: retry({ maxAttempts: 3 }) }), {}, { executor: executor(store) });
      expect(once.attempt).toBe(1);
      const thrice = await fireTriggerNow(store, trigger({ id: "cmd-exit", action: failing, retry: retry({ maxAttempts: 3, on: ["exit"] }) }), {}, { executor: executor(store) });
      expect(thrice.status).toBe("errored");
      expect(thrice.attempt).toBe(3);
    });
  });

  test("a retrying job resumes after a restart with the same delivery id and keeps its slot", async () => {
    await withTempStore(async (store) => {
      await withServer([503, 200], async (url, hits) => {
        const trig = httpTrigger(url, { retry: retry({ backoff: "400ms", maxBackoff: "400ms" }) });
        const first = new DeliveryManager(store, executor(store));
        await first.init([trig]);
        const job = (await first.handle(trig, activation(trig, { n: 1 })))!;
        await first.handle(trig, activation(trig, { n: 2 }));
        await waitForStatus(store, job.id, "retrying");
        await first.shutdown();
        expect((await store.readDeliveryState()).hook?.inFlight?.map((entry) => entry.job.id)).toEqual([job.id]);
        expect((await store.readDeliveryState()).hook?.queue).toHaveLength(1);

        const second = new DeliveryManager(store, executor(store));
        await second.init([trig]);
        const terminal = await waitForTerminalJobs(store, 2, 5_000);
        await waitForInFlight(store, "hook", 0);
        await second.shutdown();
        const resumed = terminal.find((item) => item.id === job.id)!;
        expect(resumed.status).toBe("completed");
        expect(resumed.attempt).toBe(2);
        expect(hits.filter((hit) => hit.key === job.deliveryId)).toHaveLength(2);
        expect(hits).toHaveLength(3);
        expect(hits[2]?.key).not.toBe(job.deliveryId);
        expect(await ledgerEvents(store, "pollinate.job.resumed")).toEqual([expect.objectContaining({ job_id: job.id, delivery_id: job.deliveryId, recovered_from: "retrying" })]);
      });
    });
  });

  test("an interrupted running attempt counts as failed and is retried after a restart", async () => {
    await withTempStore(async (store) => {
      await withServer([200], async (url, hits) => {
        const trig = httpTrigger(url, { retry: retry() });
        const act = { ...activation(trig), metadata: { deliveryId: "hook:manual:x" } };
        const job: Job = { id: "HO.abc", triggerId: trig.id, deliveryId: "hook:manual:x", source: "manual", status: "queued", context: {}, action: trig.action, queuedAt: new Date().toISOString(), batch: [{}] };
        await store.saveJob({ ...job, status: "running", attempt: 1, startedAt: new Date().toISOString() });
        await store.writeDeliveryState({ hook: { queue: [], inFlight: [{ job, activation: act, batch: [{}] }] } });
        const manager = new DeliveryManager(store, executor(store));
        await manager.init([trig]);
        const [done] = await waitForTerminalJobs(store, 1);
        await manager.shutdown();
        expect(done).toMatchObject({ status: "completed", attempt: 2 });
        expect(done?.attempts?.[0]).toMatchObject({ attempt: 1, retryable: true });
        expect(hits).toEqual([{ key: "hook:manual:x", attempt: "2" }]);
        expect(await ledgerEvents(store, "pollinate.job.resumed")).toEqual([expect.objectContaining({ recovered_from: "running" })]);
      });
    });
  });

  test("an interrupted job without a policy is not resumed", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "plain" });
      const job: Job = { id: "PL.abc", triggerId: trig.id, source: "manual", status: "running", context: {}, action: trig.action, queuedAt: new Date().toISOString() };
      await store.saveJob(job);
      await store.writeDeliveryState({ plain: { queue: [], inFlight: [{ job, activation: activation(trig), batch: [{}] }] } });
      const manager = new DeliveryManager(store, executor(store));
      await manager.init([trig]);
      await manager.shutdown();
      expect((await store.getJob(job.id))?.status).toBe("running");
      expect(manager.ownsJob(job.id)).toBe(false);
      expect((await store.readDeliveryState()).plain?.inFlight).toBeUndefined();
    });
  });

  test("removing or disabling a trigger cancels its retrying and queued jobs", async () => {
    await withTempStore(async (store) => {
      await withServer([503], async (url) => {
        const trig = httpTrigger(url, { retry: retry({ backoff: "5s", maxBackoff: "5s" }) });
        const manager = new DeliveryManager(store, executor(store));
        await manager.init([trig]);
        const retrying = (await manager.handle(trig, activation(trig)))!;
        const queued = (await manager.handle(trig, activation(trig)))!;
        await waitForStatus(store, retrying.id, "retrying");
        await manager.init([{ ...trig, enabled: false }]);
        expect((await waitForStatus(store, retrying.id, "cancelled")).error).toContain("trigger-removed");
        expect((await store.getJob(queued.id))?.status).toBe("cancelled");
        const cancelled = await ledgerEvents(store, "pollinate.job.cancelled");
        expect(cancelled.map((entry) => entry.reason)).toEqual(["trigger-removed", "trigger-removed"]);
        await manager.shutdown();
      });
    });
  });

  test("maxQueued drops the newest activation", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "full", delivery: { mode: { strategy: "immediate" }, maxConcurrent: 1, maxQueued: 1 }, action: { kind: "command", command: "sleep 0.3" } });
      const manager = new DeliveryManager(store, executor(store));
      await manager.init([trig]);
      await manager.handle(trig, activation(trig, { n: 1 }));
      await waitForJobs(store, 1, "running");
      await manager.handle(trig, activation(trig, { n: 2 }));
      const dropped = await manager.handle(trig, activation(trig, { n: 3 }));
      expect(dropped).toBeNull();
      expect(await ledgerEvents(store, "pollinate.delivery.dropped")).toEqual([expect.objectContaining({ trigger_id: "full", queued: 1, max_queued: 1 })]);
      await waitForTerminalJobs(store, 2, 3_000);
      expect(await store.listJobs()).toHaveLength(2);
      await manager.shutdown();
    });
  });

  test("an admitted schedule delivery that never became a job is dispatched after a restart", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "sched", source: { kind: "schedule", timing: { type: "every", interval: "1h" } } });
      const claimedAt = Date.now() - 1000;
      const ours: Activation = { triggerId: "sched", source: "schedule", payload: { scheduled_at: "2026-11-25T10:00:00.000Z" }, receivedAt: new Date().toISOString(), metadata: { deliveryId: "sched:sched:2026-11-25T10:00:00.000Z", stableDeliveryId: true } };
      const unclaimed: Activation = { ...ours, payload: { scheduled_at: "2026-11-25T11:00:00.000Z" }, metadata: { deliveryId: "sched:sched:2026-11-25T11:00:00.000Z", stableDeliveryId: true } };
      const foreign: Activation = { ...ours, payload: { scheduled_at: "2026-11-25T12:00:00.000Z" }, metadata: { deliveryId: "sched:sched:2026-11-25T12:00:00.000Z", stableDeliveryId: true } };
      await store.claimDelivery("sched", ours.metadata!.deliveryId!, claimedAt);
      await store.claimDelivery("sched", foreign.metadata!.deliveryId!, claimedAt - 5);
      await store.writeDeliveryState({
        sched: {
          admitting: {
            [ours.metadata!.deliveryId!]: { activation: ours, claimedAt },
            [unclaimed.metadata!.deliveryId!]: { activation: unclaimed, claimedAt },
            [foreign.metadata!.deliveryId!]: { activation: foreign, claimedAt },
          },
        },
      });
      const manager = new DeliveryManager(store, executor(store));
      await manager.init([trig]);
      const jobs = await waitForTerminalJobs(store, 2);
      await manager.shutdown();
      expect(jobs.map((job) => job.deliveryId).sort()).toEqual([ours.metadata!.deliveryId, unclaimed.metadata!.deliveryId].sort());
      expect((await ledgerEvents(store, "pollinate.delivery.duplicate")).map((entry) => entry.delivery_id)).toEqual([foreign.metadata!.deliveryId]);
      expect((await store.readDeliveryState()).sched?.admitting).toBeUndefined();
    });
  });
});
