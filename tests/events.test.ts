import { appendFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PollinateDaemon } from "../src/daemon.js";
import { EventsRequestError, openEventsStream, parseEventsQuery, TriggerTagIndex, type EventsQuery } from "../src/events.js";
import { ledgerPath, ledgerStatePath, previousLedgerPath, readLedgerGeneration, rotateLedgerIfLarge } from "../src/fsx.js";
import type { PollinateStore } from "../src/store.js";
import { trigger, withTempStore } from "./helpers.js";

type Line = Record<string, unknown> & { cursor: string };

function query(params: string): EventsQuery {
  return parseEventsQuery(new URLSearchParams(params));
}

async function collect(root: string, params: string, tags?: TriggerTagIndex): Promise<Line[]> {
  const lines: Line[] = [];
  const stream = await openEventsStream({ root, query: query(params), tags });
  await stream.run({ signal: new AbortController().signal, write: async (line) => void lines.push(JSON.parse(line) as Line) });
  return lines;
}

function follow(root: string, params: string, options: { tags?: TriggerTagIndex; heartbeatMs?: number; pollMs?: number } = {}) {
  const lines: Line[] = [];
  const controller = new AbortController();
  const done = openEventsStream({ root, query: query(params), ...options }).then((stream) =>
    stream.run({ signal: controller.signal, write: async (line) => void lines.push(JSON.parse(line) as Line) }),
  );
  return {
    lines,
    events: () => lines.filter((line) => typeof line.event === "string"),
    async waitFor(predicate: (lines: Line[]) => boolean, timeoutMs = 3_000) {
      const start = Date.now();
      while (!predicate(lines)) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out; got ${JSON.stringify(lines)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async stop() {
      controller.abort();
      await done;
    },
  };
}

async function appendNumbered(store: PollinateStore, from: number, count: number, extra: Record<string, unknown> = {}): Promise<void> {
  for (let n = from; n < from + count; n += 1) await store.appendLedger({ event: "pollinate.test.n", n, ...extra });
}

function numbers(lines: Line[]): number[] {
  return lines.filter((line) => line.event === "pollinate.test.n").map((line) => line.n as number);
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

const QUIET_DAEMON_CONFIG = `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 50
contextTimeout = "1s"
commandTimeout = "1s"
`;

describe("events cursor", () => {
  test("rejects malformed cursors and cursors inside a line", async () => {
    await withTempStore(async (store, root) => {
      for (const bad of ["abc", "1-", "-5", "1-2-3", "1.5-3"]) expect(() => query(`after=${bad}`)).toThrow(EventsRequestError);
      await store.appendLedger({ event: "pollinate.test.one" });
      await expect(collect(root, "after=1-3")).rejects.toMatchObject({ code: "invalid_request" });
    });
  });

  test("without after it starts at the current end with a heartbeat, and without follow it closes", async () => {
    await withTempStore(async (store, root) => {
      await appendNumbered(store, 0, 3);
      const size = (await stat(ledgerPath(root))).size;
      const lines = await collect(root, "");
      expect(lines).toEqual([{ heartbeat: true, cursor: `1-${size}` }]);
    });
  });

  test("resumes after a cursor with exactly the later lines and ends with a heartbeat at the end", async () => {
    await withTempStore(async (store, root) => {
      await appendNumbered(store, 0, 5);
      const all = await collect(root, "after=1-0");
      expect(numbers(all)).toEqual(range(0, 5));
      const resumed = await collect(root, `after=${all[1]!.cursor}`);
      expect(numbers(resumed)).toEqual([2, 3, 4]);
      expect(resumed.at(-1)).toEqual({ heartbeat: true, cursor: all[4]!.cursor });
      expect(all[4]!.cursor).toBe(`1-${(await stat(ledgerPath(root))).size}`);
    });
  });

  test("never emits a partial line", async () => {
    await withTempStore(async (store, root) => {
      await appendNumbered(store, 0, 1);
      await appendFile(ledgerPath(root), '{"event":"pollinate.test.n","n":1');
      const first = await collect(root, "after=1-0");
      expect(numbers(first)).toEqual([0]);
      await appendFile(ledgerPath(root), "}\n");
      const second = await collect(root, `after=${first[0]!.cursor}`);
      expect(numbers(second)).toEqual([1]);
    });
  });
});

describe("ledger generations", () => {
  test("rotation bumps the generation kept in state/ledger.json and the previous file keeps serving", async () => {
    await withTempStore(async (store, root) => {
      expect(await readLedgerGeneration(root)).toBe(1);
      await appendNumbered(store, 0, 3);
      const before = await collect(root, "after=1-0");
      expect(await rotateLedgerIfLarge(root, 0.00001)).toBe(2);
      expect(await readLedgerGeneration(root)).toBe(2);
      await appendNumbered(store, 3, 2);
      const resumed = await collect(root, `after=${before[0]!.cursor}`);
      expect(numbers(resumed)).toEqual([1, 2, 3, 4]);
      expect(resumed.find((line) => line.n === 3)!.cursor.startsWith("2-")).toBe(true);
    });
  });

  test("a crash between the rename and the generation write does not mislabel offsets", async () => {
    await withTempStore(async (store, root) => {
      await appendNumbered(store, 0, 2);
      const { ino } = await stat(ledgerPath(root), { bigint: true });
      await writeFile(ledgerStatePath(root), JSON.stringify({ generation: 1, rotating: { ino: String(ino) } }));
      expect(await readLedgerGeneration(root)).toBe(1);
      await rename(ledgerPath(root), previousLedgerPath(root));
      expect(await readLedgerGeneration(root)).toBe(2);
      await appendNumbered(store, 2, 1);
      expect(numbers(await collect(root, "after=1-0"))).toEqual([0, 1, 2]);
      expect(await rotateLedgerIfLarge(root, 0.00001)).toBe(3);
      expect(await readLedgerGeneration(root)).toBe(3);
    });
  });

  test("a cursor whose generation rotated away gets a gap, then the oldest available lines", async () => {
    await withTempStore(async (store, root) => {
      await appendNumbered(store, 0, 2);
      const stale = (await collect(root, "after=1-0"))[0]!.cursor;
      await rotateLedgerIfLarge(root, 0.00001);
      await appendNumbered(store, 2, 2);
      await rotateLedgerIfLarge(root, 0.00001);
      await appendNumbered(store, 4, 1);
      const lines = await collect(root, `after=${stale}`);
      expect(lines[0]).toEqual({ gap: true, cursor: "2-0" });
      expect(numbers(lines)).toEqual([2, 3, 4]);
      const future = await collect(root, "after=9-0");
      expect(future[0]).toEqual({ gap: true, cursor: "2-0" });
    });
  });
});

describe("events follow", () => {
  test("sends heartbeats while idle", async () => {
    await withTempStore(async (_store, root) => {
      const follower = follow(root, "follow=1", { heartbeatMs: 30 });
      await follower.waitFor((lines) => lines.filter((line) => line.heartbeat).length >= 3);
      await follower.stop();
      expect(follower.lines.every((line) => line.heartbeat === true && line.cursor === "1-0")).toBe(true);
    });
  });

  test("follows appends and survives rotations without loss or duplicates", async () => {
    await withTempStore(async (store, root) => {
      const follower = follow(root, "follow=1&types=pollinate.test.n", { pollMs: 20 });
      await follower.waitFor((lines) => lines.length >= 1);
      for (let round = 0; round < 4; round += 1) {
        const writing = appendNumbered(store, round * 10, 10);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await rotateLedgerIfLarge(root, 0.00001);
        await writing;
        await follower.waitFor((lines) => numbers(lines).length >= (round + 1) * 10);
      }
      await appendNumbered(store, 40, 5);
      await follower.waitFor((lines) => numbers(lines).length >= 45);
      await follower.stop();
      expect(numbers(follower.lines)).toEqual(range(0, 45));
      expect(follower.lines.some((line) => line.gap)).toBe(false);
    });
  });

  test("filters by trigger, types and tag, including a just-removed trigger's tag", async () => {
    await withTempStore(async (store, root) => {
      const tags = TriggerTagIndex.forStore(root);
      await tags.load();
      await tags.observe([trigger({ id: "alpha", tags: ["apiary"] }), trigger({ id: "beta", tags: ["other"] })]);
      await store.appendLedger({ event: "pollinate.job.queued", trigger_id: "alpha" });
      await store.appendLedger({ event: "pollinate.job.queued", trigger_id: "beta" });
      await store.appendLedger({ event: "pollinate.job.completed", trigger_id: "alpha" });
      await store.appendLedger({ event: "pollinate.daemon.started" });
      await tags.observe([trigger({ id: "beta", tags: ["other"] })]);
      await store.appendLedger({ event: "pollinate.trigger.removed", trigger_id: "alpha" });

      const reloaded = TriggerTagIndex.forStore(root);
      await reloaded.load();
      const pick = (lines: Line[]) => lines.filter((line) => line.event).map((line) => `${line.event}:${line.trigger_id ?? ""}`);
      expect(pick(await collect(root, "after=1-0&trigger=beta"))).toEqual(["pollinate.job.queued:beta"]);
      expect(pick(await collect(root, "after=1-0&types=pollinate.job.completed,pollinate.daemon.started"))).toEqual(["pollinate.job.completed:alpha", "pollinate.daemon.started:"]);
      expect(pick(await collect(root, "after=1-0&tag=apiary", reloaded))).toEqual(["pollinate.job.queued:alpha", "pollinate.job.completed:alpha", "pollinate.trigger.removed:alpha"]);
      expect(pick(await collect(root, "after=1-0&tag=apiary&types=pollinate.job.queued", reloaded))).toEqual(["pollinate.job.queued:alpha"]);
    });
  });

  test("remembers triggers removed while no daemon was watching", async () => {
    await withTempStore(async (_store, root) => {
      const before = TriggerTagIndex.forStore(root);
      await before.observe([trigger({ id: "gone", tags: ["apiary"] })]);
      const after = TriggerTagIndex.forStore(root);
      await after.load();
      await after.observe([]);
      expect(await after.tagsOf("gone")).toEqual(["apiary"]);
    });
  });

  test("matches a trigger added after the last reload by reading its file", async () => {
    await withTempStore(async (store, root) => {
      const tags = TriggerTagIndex.forStore(root, (id) => store.getTrigger(id));
      await tags.observe([]);
      await store.saveTrigger(trigger({ id: "fresh", tags: ["apiary"] }));
      await store.appendLedger({ event: "pollinate.trigger.added", trigger_id: "fresh" });
      await store.appendLedger({ event: "pollinate.job.queued", trigger_id: "fresh" });
      await store.appendLedger({ event: "pollinate.job.queued", trigger_id: "missing" });
      const lines = (await collect(root, "after=1-0&tag=apiary", tags)).filter((line) => line.event);
      expect(lines.map((line) => `${line.event}:${line.trigger_id}`)).toEqual(["pollinate.trigger.added:fresh", "pollinate.job.queued:fresh"]);
    });
  });

  test("a follower that disconnects gets exactly the 50 events written across a daemon restart", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), QUIET_DAEMON_CONFIG);
      let daemon = new PollinateDaemon(store);
      await daemon.start();
      const follower = follow(root, "follow=1", { pollMs: 20 });
      await follower.waitFor((lines) => lines.length >= 1);
      await appendNumbered(store, -3, 3);
      await follower.waitFor((lines) => numbers(lines).length >= 3);
      await follower.stop();
      const last = follower.lines.at(-1)!.cursor;

      await daemon.stop();
      await appendNumbered(store, 0, 20);
      daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await appendNumbered(store, 20, 30);
        const lines = await collect(root, `after=${last}&types=pollinate.test.n`);
        expect(numbers(lines)).toEqual(range(0, 50));
        const events = lines.filter((line) => line.event);
        expect(new Set(events.map((line) => line.cursor)).size).toBe(50);
      } finally {
        await daemon.stop();
      }
    });
  });
});
