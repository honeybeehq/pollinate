import http from "node:http";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DuplicateDeliveryError, fireTriggerNow } from "../src/actions.js";
import { batchDeliveryId, DeliveryManager } from "../src/delivery.js";
import { WebhookServer } from "../src/webhook.js";
import type { Activation, Trigger } from "../src/types.js";
import type { PollinateStore } from "../src/store.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

function executor(store: PollinateStore): ActionExecutor {
  return new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 2000 });
}

async function withWebhook(store: PollinateStore, trig: Trigger, fn: (url: string) => Promise<void>): Promise<void> {
  const delivery = new DeliveryManager(store, executor(store));
  await delivery.init([trig]);
  const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
  await server.start();
  try {
    const path = trig.source.kind === "webhook" ? trig.source.webhook.path : "";
    await fn(`http://127.0.0.1:${server.address()!.port}/hook/${path}`);
  } finally {
    await server.stop();
    await delivery.shutdown();
  }
}

describe("delivery identity", () => {
  test("identical webhook bodies without an id header become two deliveries", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "wh", source: { kind: "webhook", webhook: { path: "wh" } }, action: { kind: "emit", subject: "x", payload: "{{delivery_id}}" } });
      await store.saveTrigger(trig);
      await withWebhook(store, trig, async (url) => {
        for (let i = 0; i < 2; i += 1) await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const jobs = await waitForTerminalJobs(store, 2);
        const ids = jobs.map((job) => job.deliveryId);
        expect(new Set(ids).size).toBe(2);
        for (const job of jobs) {
          expect(job.deliveryId).toMatch(/^wh:wh:[0-9a-f-]{36}$/);
          expect(job.context.delivery_id).toBe(job.deliveryId);
        }
      });
    });
  });

  test("provider delivery ids stay duplicates across a server restart", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "gh", source: { kind: "webhook", webhook: { path: "gh" } } });
      await store.saveTrigger(trig);
      const headers = { "content-type": "application/json", "x-github-delivery": "guid-1" };
      await withWebhook(store, trig, async (url) => {
        expect(await (await fetch(url, { method: "POST", headers, body: "{}" })).json()).toMatchObject({ accepted: true, delivery_id: "gh:wh:guid-1" });
        await waitForTerminalJobs(store, 1);
      });
      await withWebhook(store, trig, async (url) => {
        expect(await (await fetch(url, { method: "POST", headers, body: "{}" })).json()).toMatchObject({ duplicate: true });
      });
      expect(await store.listJobs()).toHaveLength(1);
    });
  });

  test("deliveryIdHeader names a custom provider header", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "custom", source: { kind: "webhook", webhook: { path: "custom", deliveryIdHeader: "X-Event-Id" } } });
      await store.saveTrigger(trig);
      await withWebhook(store, trig, async (url) => {
        const headers = { "content-type": "application/json", "x-event-id": "evt-9" };
        await fetch(url, { method: "POST", headers, body: "{}" });
        expect(await (await fetch(url, { method: "POST", headers, body: "{}" })).json()).toMatchObject({ duplicate: true });
        const [job] = await waitForTerminalJobs(store, 1);
        expect(job?.deliveryId).toBe("custom:wh:evt-9");
      });
    });
  });

  test("schedule fires dedupe on scheduled_at and ledger delivery.duplicate", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "sched", source: { kind: "schedule", timing: { type: "every", interval: "1m" } }, action: { kind: "emit", subject: "x", payload: "{{scheduled_at}}" } });
      await store.saveTrigger(trig);
      const activation: Activation = {
        triggerId: trig.id,
        source: "schedule",
        payload: { scheduled_at: "2026-11-25T10:00:00.000Z" },
        receivedAt: new Date().toISOString(),
        metadata: { deliveryId: "sched:sched:2026-11-25T10:00:00.000Z", stableDeliveryId: true },
      };
      const first = new DeliveryManager(store, executor(store));
      await first.init([trig]);
      expect(await first.handle(trig, activation)).not.toBeNull();
      await waitForTerminalJobs(store, 1);
      await first.shutdown();
      const second = new DeliveryManager(store, executor(store));
      await second.init([trig]);
      expect(await second.handle(trig, activation)).toBeNull();
      await second.shutdown();
      const ledger = (await store.readLedger()).join("\n");
      expect(ledger).toContain('"event":"pollinate.delivery.duplicate"');
      const [job] = await store.listJobs();
      expect(job?.context.scheduled_at).toBe("2026-11-25T10:00:00.000Z");
    });
  });

  test("manual fires with a caller delivery id run once", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "man" });
      await store.saveTrigger(trig);
      const job = await fireTriggerNow(store, trig, {}, { executor: executor(store), deliveryId: "k1" });
      expect(job.deliveryId).toBe("man:k1");
      await expect(fireTriggerNow(store, trig, {}, { executor: executor(store), deliveryId: "k1" })).rejects.toBeInstanceOf(DuplicateDeliveryError);
      const plain = await fireTriggerNow(store, trig, {}, { executor: executor(store) });
      expect(plain.deliveryId).toMatch(/^man:manual:/);
      await store.removeTrigger(trig.id);
      expect((await store.readDeliveriesSeen())[trig.id]).toBeUndefined();
    });
  });

  test("batched jobs get a batch id over member ids and expose delivery_ids", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "bat",
        delivery: { mode: { strategy: "batched", window: "10s", maxBatch: 2 }, maxConcurrent: 1 },
        action: { kind: "emit", subject: "x", payload: "{{delivery_ids}}" },
      });
      await store.saveTrigger(trig);
      const manager = new DeliveryManager(store, executor(store));
      await manager.init([trig]);
      const at = new Date().toISOString();
      const ids = ["bat:a", "bat:b"];
      for (const id of ids) await manager.handle(trig, { triggerId: trig.id, source: "manual", payload: {}, receivedAt: at, metadata: { deliveryId: id } });
      const [job] = await waitForTerminalJobs(store, 1);
      await manager.shutdown();
      expect(job?.deliveryId).toBe(batchDeliveryId("bat", ids));
      expect(job?.deliveryId).toMatch(/^bat:batch:[0-9a-f]{16}$/);
      expect(JSON.parse(job!.context.delivery_ids!)).toEqual(ids);
    });
  });

  test("http actions send delivery headers unless the trigger sets them", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((request, response) => {
      seen.push(request.headers);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await withTempStore(async (store) => {
        const plain = trigger({ id: "hp", action: { kind: "http", method: "POST", url: `http://127.0.0.1:${port}/`, body: "{{delivery_id}}" } });
        const custom = trigger({ id: "hc", action: { kind: "http", method: "POST", url: `http://127.0.0.1:${port}/`, headers: { "idempotency-key": "mine" } } });
        const job = await fireTriggerNow(store, plain, {}, { executor: executor(store) });
        await fireTriggerNow(store, custom, {}, { executor: executor(store) });
        expect(job.status).toBe("completed");
        expect(seen[0]).toMatchObject({
          "idempotency-key": job.deliveryId,
          "x-pollinate-delivery": job.deliveryId,
          "x-pollinate-trigger": "hp",
          "x-pollinate-attempt": "1",
        });
        expect(seen[1]?.["idempotency-key"]).toBe("mine");
        expect(seen[1]?.["x-pollinate-delivery"]).toMatch(/^hc:manual:/);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
