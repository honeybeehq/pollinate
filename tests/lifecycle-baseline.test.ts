import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor } from "../src/actions.js";
import { parseTriggerToml, triggerToToml } from "../src/config.js";
import { DeliveryManager } from "../src/delivery.js";
import { gcTemporaryHooks } from "../src/hooks.js";
import { PollEngine } from "../src/poll.js";
import { nextFireAfter } from "../src/schedule.js";
import type { Trigger } from "../src/types.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

function newDelivery(store: ConstructorParameters<typeof DeliveryManager>[0]): DeliveryManager {
  return new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
}

async function ledgerEvents(root: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(root, "ledger.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function filePoll(path: string, baseline: boolean): Trigger {
  return trigger({
    id: "lines",
    source: { kind: "poll", poll: { interval: "1h", emit: "per-item", fetch: { kind: "file", path }, cursor: { strategy: "append-offset" }, ...(baseline ? { baseline } : {}) } },
  });
}

describe("config", () => {
  test("baseline and startAt parse in both key styles and round-trip", () => {
    for (const [baselineKey, startKey] of [["baseline", "startAt"], ["baseline", "start_at"]]) {
      const poll = parseTriggerToml(`
[trigger]
id = "p"
[trigger.source]
kind = "poll"
[trigger.source.poll]
interval = "1m"
${baselineKey} = true
[trigger.source.poll.fetch]
kind = "file"
path = "/tmp/x"
[trigger.source.poll.cursor]
strategy = "hash"
[trigger.action]
kind = "emit"
subject = "s"
`);
      expect(poll.source.kind === "poll" && poll.source.poll.baseline).toBe(true);
      expect(parseTriggerToml(triggerToToml(poll)).source).toEqual(poll.source);
      const every = parseTriggerToml(`
[trigger]
id = "e"
[trigger.source]
kind = "schedule"
[trigger.source.timing]
type = "every"
interval = "1m"
${startKey} = "2030-01-01T00:00:00Z"
[trigger.action]
kind = "emit"
subject = "s"
`);
      expect(every.source.kind === "schedule" && every.source.timing.type === "every" && every.source.timing.startAt).toBe("2030-01-01T00:00:00Z");
      expect(parseTriggerToml(triggerToToml(every)).source).toEqual(every.source);
    }
  });

  test("startAt is refused on cron schedules", () => {
    expect(() =>
      parseTriggerToml(`
[trigger]
id = "c"
[trigger.source]
kind = "schedule"
[trigger.source.timing]
type = "cron"
expression = "* * * * *"
startAt = "2030-01-01T00:00:00Z"
[trigger.action]
kind = "emit"
subject = "s"
`),
    ).toThrow(/startAt applies only/);
  });
});

describe("startAt anchors every", () => {
  test("fires at startAt + n x interval and nothing before startAt", () => {
    const timing = { type: "every" as const, interval: "10m", startAt: "2030-01-01T00:00:00.000Z" };
    expect(nextFireAfter(timing, new Date("2029-12-31T23:00:00Z")).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(nextFireAfter(timing, new Date("2029-12-31T23:59:55Z")).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(nextFireAfter(timing, new Date("2030-01-01T00:00:00Z")).toISOString()).toBe("2030-01-01T00:10:00.000Z");
    expect(nextFireAfter(timing, new Date("2030-01-01T00:23:17Z")).toISOString()).toBe("2030-01-01T00:30:00.000Z");
  });
});

describe("poll baseline", () => {
  test("baseline records the cursor on the first check and emits only later lines", async () => {
    await withTempStore(async (store, root) => {
      const path = join(root, "events.log");
      await writeFile(path, Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n") + "\n");
      const poller = filePoll(path, true);
      await store.saveTrigger(poller);
      const engine = new PollEngine(store, newDelivery(store), [poller]);
      expect(await engine.pollNow(poller)).toBe(0);
      expect(await store.listJobs()).toHaveLength(0);
      expect((await ledgerEvents(root)).find((event) => event.event === "pollinate.poll.baselined")).toMatchObject({ trigger_id: "lines", item_count: 10 });
      await appendFile(path, "line 10\n");
      expect(await engine.pollNow(poller)).toBe(1);
      await waitForTerminalJobs(store, 1);
      expect(await store.listJobs()).toHaveLength(1);
    });
  });

  test("without baseline the first check emits every line, as before", async () => {
    await withTempStore(async (store, root) => {
      const path = join(root, "events.log");
      await writeFile(path, "a\nb\nc\n");
      const poller = filePoll(path, false);
      await store.saveTrigger(poller);
      const engine = new PollEngine(store, newDelivery(store), [poller]);
      expect(await engine.pollNow(poller)).toBe(3);
      await waitForTerminalJobs(store, 3);
    });
  });
});

describe("lifecycle for every source", () => {
  test("maxDeliveries counts schedule deliveries, disables, and GC removes the trigger and its state once jobs are terminal", async () => {
    await withTempStore(async (store, root) => {
      const spent = trigger({
        id: "twice",
        source: { kind: "schedule", timing: { type: "every", interval: "1m" } },
        lifecycle: { temporary: true, maxDeliveries: 2 },
      });
      await store.saveTrigger(spent);
      const delivery = newDelivery(store);
      await delivery.init([spent]);
      for (const at of ["2030-01-01T00:00:00.000Z", "2030-01-01T00:01:00.000Z", "2030-01-01T00:02:00.000Z"]) {
        await delivery.handle(spent, { triggerId: "twice", source: "schedule", payload: { scheduled_at: at }, receivedAt: at });
      }
      expect(spent.enabled).toBe(false);
      expect((await store.getTrigger("twice"))?.lifecycle?.deliveries).toBe(2);
      await waitForTerminalJobs(store, 2);
      expect(await store.listJobs()).toHaveLength(2);

      await store.writeScheduleState({ twice: { nextFireAt: "2030-01-01T00:03:00.000Z" }, other: { nextFireAt: "2030-01-01T00:03:00.000Z" } });
      await store.writeCursorState({ twice: 1, other: 2 });
      expect(await gcTemporaryHooks(store)).toEqual(["twice"]);
      expect(await store.getTrigger("twice")).toBeNull();
      expect(Object.keys(await store.readScheduleState())).toEqual(["other"]);
      expect(Object.keys(await store.readCursorState())).toEqual(["other"]);
      expect(Object.keys(await store.readDeliveriesSeen())).toEqual([]);
      const events = (await ledgerEvents(root)).map((event) => event.event);
      expect(events).toContain("pollinate.trigger.spent");
      expect(events).toContain("pollinate.state.pruned");
      expect(events).not.toContain("pollinate.hook.gc_removed");
    });
  });

  test("a spent temporary trigger with a non-terminal job is kept", async () => {
    await withTempStore(async (store) => {
      const spent = trigger({ id: "busy", lifecycle: { temporary: true, maxDeliveries: 1, deliveries: 1 } });
      await store.saveTrigger(spent);
      const now = new Date().toISOString();
      await store.saveJob({ id: "BU.aaa", triggerId: "busy", source: "schedule", status: "running", context: {}, queuedAt: now, startedAt: now });
      expect(await gcTemporaryHooks(store)).toEqual([]);
      await store.updateJob("BU.aaa", { status: "retrying", nextAttemptAt: now });
      expect(await gcTemporaryHooks(store)).toEqual([]);
      expect(await gcTemporaryHooks(store, { hasLiveJobs: () => true })).toEqual([]);
      await store.updateJob("BU.aaa", { status: "completed", completedAt: now });
      expect(await gcTemporaryHooks(store)).toEqual(["busy"]);
    });
  });

  test("expiresAt stops schedule and poll deliveries", async () => {
    await withTempStore(async (store) => {
      const expired = trigger({ id: "late", source: { kind: "schedule", timing: { type: "every", interval: "1m" } }, lifecycle: { expiresAt: "2020-01-01T00:00:00Z" } });
      await store.saveTrigger(expired);
      const delivery = newDelivery(store);
      await delivery.init([expired]);
      expect(await delivery.handle(expired, { triggerId: "late", source: "schedule", payload: { scheduled_at: "2030-01-01T00:00:00Z" }, receivedAt: new Date().toISOString() })).toBeNull();
      expect(await store.listJobs()).toHaveLength(0);
    });
  });

  test("startup prune keeps only state of triggers on disk", async () => {
    await withTempStore(async (store) => {
      await store.saveTrigger(trigger({ id: "kept" }));
      await store.writeScheduleState({ kept: {}, gone1: {}, gone2: {} });
      await store.writeDeliveryState({ gone1: {} });
      const result = await store.pruneOrphanedTriggerState();
      expect(result.entries).toBe(3);
      expect(result.files["schedule-state.json"]).toEqual({ before: 3, after: 1 });
      expect(Object.keys(await store.readScheduleState())).toEqual(["kept"]);
    });
  });
});
