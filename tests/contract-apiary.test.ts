import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PollinateDaemon } from "../src/daemon.js";
import { rotateLedgerIfLarge } from "../src/fsx.js";
import type { PollinateStore } from "../src/store.js";
import { waitForTerminalJobs, withTempStore } from "./helpers.js";

const DAEMON_CONFIG = `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 50
triggerReloadMs = 60000
contextTimeout = "1s"
commandTimeout = "1s"
`;

const BEE = "bee-a1";
const OTHER_BEE = "bee-b2";
const TROUBLE_TYPES = ["pollinate.trigger.failed", "pollinate.trigger.recovered"];
const TROUBLE_FOLLOW = `/v1/events?follow=1&tag=apiary&types=${TROUBLE_TYPES.join(",")}`;
const FIRE_ONCE = 'missedFirePolicy = "fire-once"';
const GOOD_FEED = JSON.stringify([{ id: "a" }, { id: "b" }]);
const BAD_FEED = "{not json";

type Answer = { status: number; body: Record<string, any> };
type Line = Record<string, any>;
type Context = { store: PollinateStore; root: string; socket: string; kernel: string; daemon: PollinateDaemon };

function call(socketPath: string, method: string, path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      { socketPath, method, path, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function follow(socketPath: string, path: string) {
  const lines: Line[] = [];
  let buffered = "";
  const req: ClientRequest = httpRequest({ socketPath, path }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        lines.push(JSON.parse(buffered.slice(0, newline)) as Line);
        buffered = buffered.slice(newline + 1);
      }
    });
    res.on("error", () => undefined);
  });
  req.on("error", () => undefined);
  req.end();
  const events = () => lines.filter((line) => typeof line.event === "string");
  return {
    lines,
    events,
    async waitFor(predicate: (lines: Line[]) => boolean, timeoutMs = 5_000) {
      await until(() => predicate(lines), () => `follower lines ${JSON.stringify(lines)}`, timeoutMs);
    },
    mark: () => events().length,
    async eventSince(mark: number, event: string): Promise<Line> {
      let found: Line | undefined;
      await this.waitFor(() => {
        found = events()
          .slice(mark)
          .find((line) => line.event === event);
        return found !== undefined;
      });
      return found as Line;
    },
    close: () => req.destroy(),
  };
}

async function until(probe: () => boolean | Promise<boolean>, explain: () => string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; ${explain()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

async function startKernelStub(): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function withApiaryDaemon<T>(fn: (ctx: Context) => Promise<T>, config = DAEMON_CONFIG): Promise<T> {
  return withTempStore(async (store, root) => {
    await writeFile(join(root, "pollinate.toml"), config);
    const kernel = await startKernelStub();
    const ctx: Context = { store, root, socket: join(root, "pollinated.sock"), kernel: kernel.base, daemon: new PollinateDaemon(store) };
    try {
      await ctx.daemon.start();
      return await fn(ctx);
    } finally {
      await ctx.daemon.stop();
      await kernel.close();
    }
  });
}

function post(url: string, body: string): string[] {
  return ['kind = "http"', 'method = "POST"', `url = ${JSON.stringify(url)}`, `body = ${JSON.stringify(body)}`, 'timeout = "30s"'];
}

function headers(table: string): string[] {
  return [`[${table}.headers]`, '"Content-Type" = "application/json"', 'Authorization = "Bearer contract-token"'];
}

function apiaryToml(spec: { id: string; beeId?: string; kernel: string; source: string[]; lifecycle?: string[]; failureAfter?: number; tags?: string[] }): string {
  const tags = spec.tags ?? ["apiary", `apiary-bee:${spec.beeId ?? BEE}`];
  return [
    "[trigger]",
    `id = ${JSON.stringify(spec.id)}`,
    `name = ${JSON.stringify(spec.id)}`,
    `tags = ${JSON.stringify(tags)}`,
    "enabled = true",
    "[trigger.source]",
    ...spec.source,
    "[trigger.delivery]",
    'mode = "immediate"',
    "maxConcurrent = 1",
    ...(spec.lifecycle?.length ? ["[trigger.lifecycle]", ...spec.lifecycle] : []),
    "[trigger.retry]",
    "maxAttempts = 1000",
    'backoff = "2s"',
    'maxBackoff = "5m"',
    'maxElapsed = "24h"',
    "[trigger.action]",
    ...post(`${spec.kernel}/hook/trigger.fire`, '{"event":{{event}},"deliveries":{{delivery_ids}},"fired_at":"{{fired_at}}","trigger":"{{trigger_id}}"}'),
    ...headers("trigger.action"),
    "[trigger.onFailure]",
    `after = ${spec.failureAfter ?? 1}`,
    'cooldown = "1h"',
    "[trigger.onFailure.action]",
    ...post(`${spec.kernel}/hook/trigger.failed`, '{"failure":{{event}},"trigger":"{{trigger_id}}"}'),
    ...headers("trigger.onFailure.action"),
    "",
  ].join("\n");
}

function inAWeek(): string {
  return new Date(Date.now() + 7 * 86_400_000).toISOString();
}

function onceSource(at: string): string[] {
  return ['kind = "schedule"', "[trigger.source.timing]", 'type = "once"', `at = ${JSON.stringify(at)}`, FIRE_ONCE];
}

function everySource(interval: string): string[] {
  return ['kind = "schedule"', "[trigger.source.timing]", 'type = "every"', `interval = ${JSON.stringify(interval)}`, FIRE_ONCE];
}

function cronSource(expression: string, timezone: string): string[] {
  return ['kind = "schedule"', "[trigger.source.timing]", 'type = "cron"', `expression = ${JSON.stringify(expression)}`, `timezone = ${JSON.stringify(timezone)}`, FIRE_ONCE];
}

function webhookSource(path: string): string[] {
  return ['kind = "webhook"', "[trigger.source.webhook]", `path = ${JSON.stringify(path)}`];
}

function monitorSource(interval: string, file: string): string[] {
  return [
    'kind = "poll"',
    "[trigger.source.poll]",
    `interval = ${JSON.stringify(interval)}`,
    'emit = "per-poll"',
    "baseline = true",
    "[trigger.source.poll.fetch]",
    'kind = "file"',
    `path = ${JSON.stringify(file)}`,
    "[trigger.source.poll.cursor]",
    'strategy = "jsonpath"',
    'jsonpath = "$[*].id"',
  ];
}

const ONE_SHOT = ["temporary = true", "maxDeliveries = 1"];

function expiring(): string[] {
  return ["temporary = true", `expiresAt = ${JSON.stringify(new Date(Date.now() + 86_400_000).toISOString())}`];
}

function put(ctx: Context, id: string, toml: string): Promise<Answer> {
  return call(ctx.socket, "PUT", `/v1/triggers/${id}`, { toml });
}

function listForBee(ctx: Context, beeId: string): Promise<Answer> {
  return call(ctx.socket, "GET", `/v1/triggers?tag=${encodeURIComponent(`apiary-bee:${beeId}`)}`);
}

async function setFeed(file: string, content: string): Promise<void> {
  await writeFile(`${file}.next`, content);
  await rename(`${file}.next`, file);
}

async function putMonitor(ctx: Context, id: string, file: string, options: { tags?: string[] } = {}): Promise<void> {
  await setFeed(file, GOOD_FEED);
  const answer = await put(ctx, id, apiaryToml({ id, kernel: ctx.kernel, source: monitorSource("100ms", file), lifecycle: expiring(), failureAfter: 3, ...options }));
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

async function troubleInLedger(root: string, triggerId: string): Promise<Line[]> {
  const text = await readFile(join(root, "ledger.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line)
    .filter((line) => line.trigger_id === triggerId && TROUBLE_TYPES.includes(line.event));
}

function withoutCursor(lines: Line[]): Line[] {
  return lines.map(({ cursor: _cursor, ...rest }) => rest);
}

function osloClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

describe("Apiary kernel contract: GET /v1/health", () => {
  test("answers the daemon pid, features including events, and the webhook port that serves hooks", async () => {
    await withApiaryDaemon(async (ctx) => {
      const health = await call(ctx.socket, "GET", "/v1/health");
      expect(health.status).toBe(200);
      expect(health.body.pid).toBe(process.pid);
      expect(health.body.features).toEqual(expect.arrayContaining(["events"]));
      expect(Number.isInteger(health.body.webhook.port)).toBe(true);
      expect(health.body.webhook.port).toBeGreaterThan(0);

      expect((await put(ctx, "hook-port", apiaryToml({ id: "hook-port", kernel: ctx.kernel, source: webhookSource("port-probe"), lifecycle: expiring() }))).status).toBe(200);
      const posted = await fetch(`http://127.0.0.1:${health.body.webhook.port}/hook/port-probe`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(posted.status).toBe(202);
      await waitForTerminalJobs(ctx.store, 1);
    });
  });
});

describe("Apiary kernel contract: PUT /v1/triggers/:id with {toml}", () => {
  test("a one-shot at schedule answers schedule.nextFireAt at that time", async () => {
    await withApiaryDaemon(async (ctx) => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const answer = await put(ctx, "wake-once", apiaryToml({ id: "wake-once", kernel: ctx.kernel, source: onceSource(at), lifecycle: ONE_SHOT }));
      expect(answer.status).toBe(200);
      expect(Date.parse(answer.body.schedule.nextFireAt)).toBe(Date.parse(at));
    });
  });

  test("an every schedule answers schedule.nextFireAt one interval from the call", async () => {
    await withApiaryDaemon(async (ctx) => {
      const before = Date.now();
      const answer = await put(ctx, "wake-every", apiaryToml({ id: "wake-every", kernel: ctx.kernel, source: everySource("15m") }));
      const after = Date.now();
      expect(answer.status).toBe(200);
      const next = Date.parse(answer.body.schedule.nextFireAt);
      expect(next).toBeGreaterThanOrEqual(before + 15 * 60_000);
      expect(next).toBeLessThanOrEqual(after + 15 * 60_000);
    });
  });

  test("a cron schedule with a timezone answers schedule.nextFireAt on that zone's clock", async () => {
    await withApiaryDaemon(async (ctx) => {
      const now = Date.now();
      const answer = await put(ctx, "wake-cron", apiaryToml({ id: "wake-cron", kernel: ctx.kernel, source: cronSource("30 9 * * *", "Europe/Oslo") }));
      expect(answer.status).toBe(200);
      const next = answer.body.schedule.nextFireAt as string;
      expect(Date.parse(next)).toBeGreaterThan(now);
      expect(Date.parse(next)).toBeLessThanOrEqual(now + 25 * 3_600_000);
      expect(osloClock(next)).toBe("09:30");
    });
  });

  test("a PUT on an existing id overwrites it and answers the new schedule", async () => {
    await withApiaryDaemon(async (ctx) => {
      const first = new Date(Date.now() + 3_600_000).toISOString();
      const second = new Date(Date.now() + 2 * 3_600_000).toISOString();
      expect((await put(ctx, "wake-moved", apiaryToml({ id: "wake-moved", kernel: ctx.kernel, source: onceSource(first), lifecycle: ONE_SHOT }))).status).toBe(200);
      const overwrite = await put(ctx, "wake-moved", apiaryToml({ id: "wake-moved", kernel: ctx.kernel, source: onceSource(second), lifecycle: ONE_SHOT }));
      expect(overwrite.status).toBe(200);
      expect(Date.parse(overwrite.body.schedule.nextFireAt)).toBe(Date.parse(second));
      const listed = (await listForBee(ctx, BEE)).body.triggers as Line[];
      expect(listed.map((trigger) => trigger.id)).toEqual(["wake-moved"]);
      expect(Date.parse(listed[0]?.source.timing.at)).toBe(Date.parse(second));
    });
  });

  test("a webhook answers webhook.url and webhook.localUrl, and the url takes a POST at once with 202", async () => {
    await withApiaryDaemon(async (ctx) => {
      const answer = await put(ctx, "hook-now", apiaryToml({ id: "hook-now", kernel: ctx.kernel, source: webhookSource("tok-now"), lifecycle: [...expiring(), "maxDeliveries = 1"] }));
      expect(answer.status).toBe(200);
      expect(typeof answer.body.webhook.url).toBe("string");
      expect(answer.body.webhook.localUrl).toBe(answer.body.webhook.url);
      const posted = await fetch(answer.body.webhook.url, { method: "POST", body: JSON.stringify({ ci: "done" }), headers: { "content-type": "application/json" } });
      expect(posted.status).toBe(202);
      await waitForTerminalJobs(ctx.store, 1);
    });
  });

  test("with a publicUrl, webhook.url is public and webhook.localUrl still takes a POST on loopback", async () => {
    await withApiaryDaemon(
      async (ctx) => {
        const answer = await put(ctx, "hook-public", apiaryToml({ id: "hook-public", kernel: ctx.kernel, source: webhookSource("tok-public"), lifecycle: expiring() }));
        expect(answer.status).toBe(200);
        expect(answer.body.webhook.url).toBe("https://hooks.example.test/hook/tok-public");
        const port = (await call(ctx.socket, "GET", "/v1/health")).body.webhook.port;
        expect(answer.body.webhook.localUrl).toBe(`http://127.0.0.1:${port}/hook/tok-public`);
        const posted = await fetch(answer.body.webhook.localUrl, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
        expect(posted.status).toBe(202);
        await waitForTerminalJobs(ctx.store, 1);
      },
      DAEMON_CONFIG.replace('port = 0', 'port = 0\npublicUrl = "https://hooks.example.test"'),
    );
  });

  test("a monitor whose first check fails answers 422 poll_failed with details.error and stores nothing", async () => {
    await withApiaryDaemon(async (ctx) => {
      const feed = join(ctx.root, "broken-feed.json");
      await setFeed(feed, BAD_FEED);
      const answer = await put(ctx, "mon-broken", apiaryToml({ id: "mon-broken", kernel: ctx.kernel, source: monitorSource("30s", feed), lifecycle: expiring(), failureAfter: 3 }));
      expect(answer.status).toBe(422);
      expect(answer.body.error.code).toBe("poll_failed");
      expect(typeof answer.body.error.details.error).toBe("string");
      expect(answer.body.error.details.error.length).toBeGreaterThan(0);
      expect((await listForBee(ctx, BEE)).body.triggers).toEqual([]);
    });
  });
});

describe("Apiary kernel contract: DELETE /v1/triggers/:id", () => {
  test("removes the trigger; a second DELETE answers 404 not_found, which the kernel counts as already gone", async () => {
    await withApiaryDaemon(async (ctx) => {
      expect((await put(ctx, "wake-gone", apiaryToml({ id: "wake-gone", kernel: ctx.kernel, source: everySource("1h") }))).status).toBe(200);
      expect((await call(ctx.socket, "DELETE", "/v1/triggers/wake-gone")).status).toBe(200);
      expect((await listForBee(ctx, BEE)).body.triggers).toEqual([]);
      const again = await call(ctx.socket, "DELETE", "/v1/triggers/wake-gone");
      expect(again.status).toBe(404);
      expect(again.body.error.code).toBe("not_found");
    });
  });
});

describe("Apiary kernel contract: GET /v1/triggers?tag=apiary-bee:<beeId>", () => {
  test("lists only that bee's triggers, with source.timing.{at,interval,expression,timezone} and source.poll.interval", async () => {
    await withApiaryDaemon(async (ctx) => {
      const at = inAWeek();
      const feed = join(ctx.root, "feed.json");
      await setFeed(feed, GOOD_FEED);
      const mine = [
        ["a-once", apiaryToml({ id: "a-once", kernel: ctx.kernel, source: onceSource(at), lifecycle: ONE_SHOT })],
        ["a-every", apiaryToml({ id: "a-every", kernel: ctx.kernel, source: everySource("15m") })],
        ["a-cron", apiaryToml({ id: "a-cron", kernel: ctx.kernel, source: cronSource("0 9 * * 1-5", "Europe/Oslo") })],
        ["a-hook", apiaryToml({ id: "a-hook", kernel: ctx.kernel, source: webhookSource("tok-a"), lifecycle: expiring() })],
        ["a-mon", apiaryToml({ id: "a-mon", kernel: ctx.kernel, source: monitorSource("30s", feed), lifecycle: expiring(), failureAfter: 3 })],
      ] as const;
      for (const [id, toml] of mine) expect((await put(ctx, id, toml)).status, id).toBe(200);
      expect((await put(ctx, "b-every", apiaryToml({ id: "b-every", beeId: OTHER_BEE, kernel: ctx.kernel, source: everySource("1h") }))).status).toBe(200);

      const listed = await listForBee(ctx, BEE);
      expect(listed.status).toBe(200);
      const byId = new Map((listed.body.triggers as Line[]).map((trigger) => [trigger.id as string, trigger]));
      expect([...byId.keys()].sort()).toEqual(mine.map(([id]) => id).sort());
      expect(Date.parse(byId.get("a-once")?.source.timing.at)).toBe(Date.parse(at));
      expect(byId.get("a-every")?.source.timing.interval).toBe("15m");
      expect(byId.get("a-cron")?.source.timing).toMatchObject({ expression: "0 9 * * 1-5", timezone: "Europe/Oslo" });
      expect(byId.get("a-mon")?.source.poll.interval).toBe("30s");

      expect(((await listForBee(ctx, OTHER_BEE)).body.triggers as Line[]).map((trigger) => trigger.id)).toEqual(["b-every"]);
    });
  });
});

describe("Apiary kernel contract: GET /v1/events?follow=1&tag=apiary&types=pollinate.trigger.failed,pollinate.trigger.recovered", () => {
  test("a failing then recovering apiary monitor arrives as trigger.failed with error, then trigger.recovered, each with ts, trigger_id and cursor; nothing else passes the filter", async () => {
    await withEnv("POLLINATE_EVENTS_HEARTBEAT_MS", "100", () =>
      withApiaryDaemon(async (ctx) => {
        const watched = join(ctx.root, "watched.json");
        const unrelated = join(ctx.root, "unrelated.json");
        await putMonitor(ctx, "mon-watched", watched);
        await putMonitor(ctx, "mon-unrelated", unrelated, { tags: ["not-apiary"] });

        const follower = follow(ctx.socket, TROUBLE_FOLLOW);
        await follower.waitFor((lines) => lines.length >= 1);
        expect(follower.lines[0]).toMatchObject({ heartbeat: true, cursor: expect.any(String) });

        await setFeed(unrelated, BAD_FEED);
        const beforeFailure = follower.mark();
        await setFeed(watched, BAD_FEED);
        const failed = await follower.eventSince(beforeFailure, "pollinate.trigger.failed");
        const beforeRecovery = follower.mark();
        await setFeed(watched, GOOD_FEED);
        const recovered = await follower.eventSince(beforeRecovery, "pollinate.trigger.recovered");

        expect(failed).toMatchObject({ event: "pollinate.trigger.failed", trigger_id: "mon-watched", error: expect.any(String), ts: expect.any(String), cursor: expect.any(String) });
        expect(failed.error.length).toBeGreaterThan(0);
        expect(recovered).toMatchObject({ event: "pollinate.trigger.recovered", trigger_id: "mon-watched", ts: expect.any(String), cursor: expect.any(String) });
        expect(Date.parse(recovered.ts)).toBeGreaterThanOrEqual(Date.parse(failed.ts));
        expect(recovered.cursor).not.toBe(failed.cursor);

        await until(async () => (await troubleInLedger(ctx.root, "mon-unrelated")).length > 0, () => "the unrelated monitor never failed");
        const heartbeatsSoFar = follower.lines.filter((line) => line.heartbeat).length;
        await follower.waitFor((lines) => lines.filter((line) => line.heartbeat).length >= heartbeatsSoFar + 2);
        follower.close();

        expect(follower.events().every((line) => line.trigger_id === "mon-watched" && TROUBLE_TYPES.includes(line.event))).toBe(true);
        expect(follower.lines.every((line) => typeof line.cursor === "string")).toBe(true);
      }),
    );
  });

  test("a follower that reconnects with after=<last cursor> across a daemon restart gets every later event exactly once", async () => {
    await withEnv("POLLINATE_EVENTS_HEARTBEAT_MS", "100", () =>
      withApiaryDaemon(async (ctx) => {
        const watched = join(ctx.root, "watched.json");
        await putMonitor(ctx, "mon-restart", watched);
        const troubleCount = async () => (await troubleInLedger(ctx.root, "mon-restart")).length;
        const lastTrouble = async () => (await troubleInLedger(ctx.root, "mon-restart")).at(-1)?.event;

        const first = follow(ctx.socket, TROUBLE_FOLLOW);
        await first.waitFor((lines) => lines.length >= 1);
        for (const [feed, event] of [
          [BAD_FEED, "pollinate.trigger.failed"],
          [GOOD_FEED, "pollinate.trigger.recovered"],
          [BAD_FEED, "pollinate.trigger.failed"],
        ] as const) {
          const mark = first.mark();
          await setFeed(watched, feed);
          await first.eventSince(mark, event);
        }
        first.close();
        const stored = first.lines.at(-1)?.cursor as string;
        const seenBefore = first.events();

        await setFeed(watched, GOOD_FEED);
        await until(async () => (await lastTrouble()) === "pollinate.trigger.recovered", () => "no recovery before the restart");
        await ctx.daemon.stop();
        const beforeRestart = await troubleCount();
        await setFeed(watched, BAD_FEED);
        ctx.daemon = new PollinateDaemon(ctx.store);
        await ctx.daemon.start();
        await until(async () => (await troubleCount()) > beforeRestart, () => "no failure after the restart");
        await setFeed(watched, GOOD_FEED);
        await until(async () => (await lastTrouble()) === "pollinate.trigger.recovered", () => "no recovery after the restart");
        const ledgerTrouble = await troubleInLedger(ctx.root, "mon-restart");

        const resumed = follow(ctx.socket, `${TROUBLE_FOLLOW}&after=${encodeURIComponent(stored)}`);
        await resumed.waitFor((lines) => resumed.events().length >= ledgerTrouble.length - seenBefore.length && lines.at(-1)?.heartbeat === true);
        const heartbeats = resumed.lines.filter((line) => line.heartbeat).length;
        await resumed.waitFor((lines) => lines.filter((line) => line.heartbeat).length >= heartbeats + 2);
        resumed.close();

        const missed = resumed.events();
        expect(missed.length).toBeGreaterThanOrEqual(3);
        expect(missed.map((line) => line.event)).toEqual(expect.arrayContaining(TROUBLE_TYPES));
        expect([...withoutCursor(seenBefore), ...withoutCursor(missed)]).toEqual(ledgerTrouble);
        expect(new Set(missed.map((line) => line.cursor)).size).toBe(missed.length);
        expect(missed.map((line) => line.cursor)).not.toContain(stored);
      }),
    );
  });

  test("a stored cursor whose ledger generation rotated away answers a gap line with a cursor first, then keeps following", async () => {
    await withEnv("POLLINATE_EVENTS_HEARTBEAT_MS", "100", () =>
      withApiaryDaemon(async (ctx) => {
        const watched = join(ctx.root, "watched.json");
        const start = follow(ctx.socket, TROUBLE_FOLLOW);
        await start.waitFor((lines) => lines.length >= 1);
        start.close();
        const stored = start.lines[0]?.cursor as string;

        await putMonitor(ctx, "mon-rotated", watched);
        await rotateLedgerIfLarge(ctx.root, 0.000001);
        expect((await put(ctx, "wake-filler", apiaryToml({ id: "wake-filler", kernel: ctx.kernel, source: everySource("1h") }))).status).toBe(200);
        await rotateLedgerIfLarge(ctx.root, 0.000001);

        const resumed = follow(ctx.socket, `${TROUBLE_FOLLOW}&after=${encodeURIComponent(stored)}`);
        await resumed.waitFor((lines) => lines.length >= 1);
        expect(resumed.lines[0]).toMatchObject({ gap: true, cursor: expect.any(String) });
        const mark = resumed.mark();
        await setFeed(watched, BAD_FEED);
        const failed = await resumed.eventSince(mark, "pollinate.trigger.failed");
        resumed.close();
        expect(failed).toMatchObject({ trigger_id: "mon-rotated", error: expect.any(String), cursor: expect.any(String) });
      }),
    );
  });

  test("a malformed or mid-line stored cursor answers 400, and following again without after starts from a heartbeat cursor", async () => {
    await withApiaryDaemon(async (ctx) => {
      for (const stored of ["not-a-cursor", "1-3"]) {
        const answer = await call(ctx.socket, "GET", `${TROUBLE_FOLLOW}&after=${encodeURIComponent(stored)}`);
        expect(answer.status, stored).toBe(400);
      }
      const fresh = follow(ctx.socket, TROUBLE_FOLLOW);
      await fresh.waitFor((lines) => lines.length >= 1);
      fresh.close();
      expect(fresh.lines[0]).toMatchObject({ heartbeat: true, cursor: expect.any(String) });
    });
  });
});

describe("Apiary kernel contract: socket path and shutdown", () => {
  test("POLLINATE_SOCKET moves the API socket out of the store directory", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      const dir = await mkdtemp(join(tmpdir(), "pol-sock-"));
      const socket = join(dir, "api.sock");
      try {
        await withEnv("POLLINATE_SOCKET", socket, async () => {
          const daemon = new PollinateDaemon(store);
          await daemon.start();
          try {
            const health = await call(socket, "GET", "/v1/health");
            expect(health.status).toBe(200);
            expect(health.body.features).toEqual(expect.arrayContaining(["events"]));
            await expect(stat(join(root, "pollinated.sock"))).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await daemon.stop();
          }
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("a PUT while the daemon is shutting down answers 503 stopping", async () => {
    await withApiaryDaemon(async (ctx) => {
      const hook = await put(ctx, "hook-held", apiaryToml({ id: "hook-held", kernel: ctx.kernel, source: webhookSource("tok-held"), lifecycle: expiring() }));
      expect(hook.status).toBe(200);
      const held = httpRequest(hook.body.webhook.localUrl, { method: "POST", headers: { "content-type": "application/json", "content-length": "64", expect: "100-continue" } });
      held.on("error", () => undefined);
      await new Promise<void>((resolve) => {
        held.once("continue", () => resolve());
        held.flushHeaders();
      });

      const stopping = ctx.daemon.stop();
      try {
        const answer = await put(ctx, "wake-late", apiaryToml({ id: "wake-late", kernel: ctx.kernel, source: everySource("1h") }));
        expect(answer.status).toBe(503);
        expect(answer.body.error.code).toBe("stopping");
      } finally {
        held.destroy();
        await stopping;
      }
    });
  });
});
