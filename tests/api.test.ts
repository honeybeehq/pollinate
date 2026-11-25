import { request as httpRequest } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PollinateDaemon } from "../src/daemon.js";
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

type Answer = { status: number; body: Record<string, any> };

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

async function withDaemon<T>(
  fn: (ctx: { store: PollinateStore; root: string; socket: string; daemon: PollinateDaemon }) => Promise<T>,
  config = DAEMON_CONFIG,
): Promise<T> {
  return withTempStore(async (store, root) => {
    await writeFile(join(root, "pollinate.toml"), config);
    const daemon = new PollinateDaemon(store);
    await daemon.start();
    try {
      return await fn({ store, root, socket: join(root, "pollinated.sock"), daemon });
    } finally {
      await daemon.stop();
    }
  });
}

function webhookToml(id: string, path: string): string {
  return `
[trigger]
id = "${id}"
tags = ["apiary"]
[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "${path}"
[trigger.action]
kind = "emit"
subject = "test.${id}"
`;
}

function pollTrigger(id: string, path: string): Record<string, unknown> {
  return {
    id,
    source: { kind: "poll", poll: { interval: "1h", baseline: true, emit: "per-item", fetch: { kind: "file", path }, cursor: { strategy: "hash" } } },
    action: { kind: "emit", subject: `test.${id}` },
  };
}

async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

type InitWaiter = { triggerId: string; wake: () => void };

function slowDeliveryInit(daemon: PollinateDaemon, delayMs: () => number): { nextInit(triggerId: string): Promise<void> } {
  const delivery = (daemon as unknown as { delivery: { init(triggers: Array<{ id: string }>): Promise<void> } }).delivery;
  const init = delivery.init.bind(delivery);
  let waiters: InitWaiter[] = [];
  delivery.init = async (triggers) => {
    const ids = new Set(triggers.map((trigger) => trigger.id));
    const entered = waiters.filter((waiter) => ids.has(waiter.triggerId));
    waiters = waiters.filter((waiter) => !entered.includes(waiter));
    for (const waiter of entered) waiter.wake();
    await new Promise((resolve) => setTimeout(resolve, delayMs()));
    await init(triggers);
  };
  return { nextInit: (triggerId) => new Promise<void>((wake) => waiters.push({ triggerId, wake })) };
}

async function ledger(root: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(root, "ledger.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("local API v1", () => {
  test("health answers on a 0600 socket and store.json is written", async () => {
    await withDaemon(async ({ root, socket }) => {
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
      const health = await call(socket, "GET", "/v1/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        name: "pollinate",
        api: 1,
        features: ["retry", "baseline", "onFailure", "events", "doctor"],
        pid: process.pid,
        store: root,
        triggers: { total: 0, enabled: 0 },
        webhook: { bind: "127.0.0.1", publicUrl: null },
      });
      expect(health.body.webhook.port).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(join(root, "state", "store.json"), "utf8"))).toEqual({ schema: 1 });
      expect((await call(socket, "GET", "/v1/nope")).body.error.code).toBe("not_found");
      expect(await call(socket, "GET", "/v1/events")).toMatchObject({ status: 200, body: { heartbeat: true } });
      expect(await call(socket, "GET", "/v1/events?after=nope")).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
      expect(await call(socket, "POST", "/v1/health")).toMatchObject({ status: 405, body: { error: { code: "unsupported" } } });
    });
  });

  test("GET /v1/doctor answers the report pol doctor --json prints", async () => {
    await withDaemon(async ({ root, socket }) => {
      expect((await call(socket, "PUT", "/v1/triggers/wh", { toml: webhookToml("wh", "inbox") })).status).toBe(200);
      const answer = await call(socket, "GET", "/v1/doctor");
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ store: root, status: expect.any(String), exitCode: expect.any(Number), counts: { errors: expect.any(Number), warnings: expect.any(Number) } });
      expect(answer.body.fixes).toBeUndefined();
      expect(answer.body.findings).toContainEqual(expect.objectContaining({ area: "daemon", check: "running", severity: "ok" }));
      const env: NodeJS.ProcessEnv = { ...process.env, POLLINATE_STORE_ROOT: root };
      delete env.POLLINATE_SOCKET;
      const cli = await promisify(execFile)(process.execPath, [join(process.cwd(), "dist", "cli.js"), "doctor", "--json"], { env }).catch((error: { stdout: string }) => error);
      const printed = JSON.parse(cli.stdout);
      const withoutBuildCheck = ({ checkedAt: _checkedAt, findings, ...rest }: Record<string, any>) => ({
        ...rest,
        findings: findings.filter((finding: { check: string }) => finding.check !== "commit"),
      });
      expect(withoutBuildCheck(answer.body)).toEqual(withoutBuildCheck(printed));
    });
  });

  test("a PUT webhook trigger takes a POST at once, with no reload wait", async () => {
    await withDaemon(async ({ socket, store }) => {
      const put = await call(socket, "PUT", "/v1/triggers/wh", { toml: webhookToml("wh", "inbox") });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ loaded: true, created: true, trigger: { id: "wh" }, webhook: { path: "/hook/inbox" } });
      const posted = await fetch(put.body.webhook.localUrl, { method: "POST", body: JSON.stringify({ hello: "world" }), headers: { "content-type": "application/json" } });
      expect(posted.status).toBe(202);
      expect(await posted.json()).toMatchObject({ accepted: true, trigger_id: "wh" });
      await waitForTerminalJobs(store, 1);
    });
  });

  test("PUT schedule, ifAbsent, invalid bodies, GET with state, list filters, PATCH and DELETE", async () => {
    await withDaemon(async ({ socket, root }) => {
      const schedule = { id: "tick", tags: ["apiary"], source: { kind: "schedule", timing: { type: "every", interval: "1h" } }, action: { kind: "emit", subject: "t" } };
      const put = await call(socket, "PUT", "/v1/triggers/tick?ifAbsent=1", { trigger: schedule });
      expect(put.status).toBe(200);
      expect(Date.parse(put.body.schedule.nextFireAt)).toBeGreaterThan(Date.now() + 3_500_000);
      expect(await call(socket, "PUT", "/v1/triggers/tick?ifAbsent=1", { trigger: schedule })).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
      const overwrite = await call(socket, "PUT", "/v1/triggers/tick", { trigger: schedule });
      expect(overwrite).toMatchObject({ status: 200, body: { created: false } });
      expect(await call(socket, "PUT", "/v1/triggers/other", { trigger: schedule })).toMatchObject({ status: 400, body: { error: { code: "invalid_trigger" } } });
      const invalid = await call(socket, "PUT", "/v1/triggers/bad", { toml: "[trigger]\nid='bad'\n" });
      expect(invalid).toMatchObject({ status: 400, body: { error: { code: "invalid_trigger", details: { id: "bad" } } } });
      await call(socket, "PUT", "/v1/triggers/wh", { toml: webhookToml("wh", "w").replace('tags = ["apiary"]', "tags = []") });

      const got = await call(socket, "GET", "/v1/triggers/tick");
      expect(got.body.trigger).toMatchObject({ id: "tick", state: { nextFireAt: put.body.schedule.nextFireAt, lastFireAt: null, lastJob: null, consecutiveFailures: 0, deliveries: 0 } });
      expect((await call(socket, "GET", "/v1/triggers?tag=apiary")).body.triggers.map((t: { id: string }) => t.id)).toEqual(["tick"]);
      expect((await call(socket, "GET", "/v1/triggers?source=webhook")).body.triggers.map((t: { id: string }) => t.id)).toEqual(["wh"]);

      const patched = await call(socket, "PATCH", "/v1/triggers/tick", { enabled: false });
      expect(patched.body.trigger).toMatchObject({ enabled: false, state: { nextFireAt: null } });
      expect((await call(socket, "GET", "/v1/triggers?enabled=false")).body.triggers.map((t: { id: string }) => t.id)).toEqual(["tick"]);
      expect((await call(socket, "GET", "/v1/health")).body.triggers).toEqual({ total: 2, enabled: 1 });

      expect(await call(socket, "DELETE", "/v1/triggers/tick")).toMatchObject({ status: 200, body: { removed: "tick" } });
      expect(await call(socket, "GET", "/v1/triggers/tick")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
      expect(await call(socket, "DELETE", "/v1/triggers/tick")).toMatchObject({ status: 404 });
      const scheduleState = JSON.parse(await readFile(join(root, "state", "schedule-state.json"), "utf8")) as Record<string, unknown>;
      expect(scheduleState.tick).toBeUndefined();
    });
  });

  test("a poll baselines inside the PUT; a failing first check answers 422 and stores nothing", async () => {
    await withDaemon(async ({ socket, root, store }) => {
      const feed = join(root, "feed.json");
      await writeFile(feed, JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]));
      const put = await call(socket, "PUT", "/v1/triggers/feed", { trigger: pollTrigger("feed", feed) });
      expect(put).toMatchObject({ status: 200, body: { poll: { baseline: { items: 3 } } } });
      expect((await ledger(root)).filter((event) => event.event === "pollinate.poll.baselined")).toHaveLength(1);

      const broken = join(root, "broken.json");
      await writeFile(broken, "{not json");
      const failing = { ...pollTrigger("broken", broken), source: { kind: "poll", poll: { interval: "1h", fetch: { kind: "file", path: broken }, cursor: { strategy: "jsonpath", jsonpath: "$[*].id" } } } };
      const failed = await call(socket, "PUT", "/v1/triggers/broken", { trigger: failing });
      expect(failed).toMatchObject({ status: 422, body: { error: { code: "poll_failed" } } });
      expect(await store.getTrigger("broken")).toBeNull();
      expect(await call(socket, "GET", "/v1/triggers/broken")).toMatchObject({ status: 404 });
    });
  });

  test("fire goes through delivery and honours dedup; jobs list, get and cancel", async () => {
    await withDaemon(async ({ socket, store }) => {
      const manual = { id: "man", source: { kind: "manual" }, action: { kind: "emit", subject: "m" } };
      await call(socket, "PUT", "/v1/triggers/man", { trigger: manual });
      const fired = await call(socket, "POST", "/v1/triggers/man/fire", { payload: { a: 1 }, deliveryId: "d-1" });
      expect(fired.status).toBe(200);
      expect(fired.body.job).toMatchObject({ triggerId: "man", deliveryId: "man:d-1" });
      const again = await call(socket, "POST", "/v1/triggers/man/fire", { payload: { a: 1 }, deliveryId: "d-1" });
      expect(again).toMatchObject({ status: 409, body: { error: { code: "conflict", details: { reason: "duplicate" } } } });
      await waitForTerminalJobs(store, 1);

      const listed = await call(socket, "GET", "/v1/jobs?trigger=man&limit=5");
      expect(listed.body.jobs).toHaveLength(1);
      const jobId = listed.body.jobs[0].id as string;
      expect((await call(socket, "GET", `/v1/jobs/${jobId}`)).body.job).toMatchObject({ id: jobId, status: "completed" });
      expect((await call(socket, "GET", "/v1/jobs?status=queued")).body.jobs).toEqual([]);
      expect(await call(socket, "GET", "/v1/jobs?status=nope")).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
      expect(await call(socket, "GET", "/v1/jobs/XX.missing")).toMatchObject({ status: 404 });
      expect((await call(socket, "POST", `/v1/jobs/${jobId}/cancel`)).body.job.status).toBe("completed");

      const queued = await store.allocateJobIdentity((await store.getTrigger("man"))!);
      await store.saveJob({ id: queued.id, uuid: queued.uuid, idPrefix: queued.idPrefix, triggerId: "man", source: "manual", status: "retrying", context: {}, queuedAt: new Date().toISOString() });
      expect((await call(socket, "POST", `/v1/jobs/${queued.id}/cancel`)).body.job.status).toBe("cancelled");
      expect((await call(socket, "GET", "/v1/triggers/man")).body.trigger.state.lastJob).toMatchObject({ status: expect.any(String) });
    });
  });

  test("a stale socket is replaced, a second daemon leaves the first one's socket alone, stop unlinks it", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      const socket = join(root, "pollinated.sock");
      await leaveStaleSocket(socket);
      expect((await stat(socket)).isSocket()).toBe(true);

      const first = new PollinateDaemon(store);
      await first.start();
      try {
        expect((await call(socket, "GET", "/v1/health")).status).toBe(200);
        const second = new PollinateDaemon(store);
        await expect(second.start()).rejects.toMatchObject({ reason: "locked" });
        expect((await call(socket, "GET", "/v1/health")).body.pid).toBe(process.pid);
      } finally {
        await first.stop();
      }
      await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("a newer store schema and an over-long socket path refuse the start", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      await writeFile(join(root, "state", "store.json"), JSON.stringify({ schema: 2 }));
      await expect(new PollinateDaemon(store).start()).rejects.toThrow(/store schema 2 .* newer/);
      await writeFile(join(root, "state", "store.json"), JSON.stringify({ schema: 1 }));
      const previous = process.env.POLLINATE_SOCKET;
      process.env.POLLINATE_SOCKET = join(root, "x".repeat(120), "s.sock");
      try {
        await expect(new PollinateDaemon(store).start()).rejects.toThrow(/over the 103-byte Unix socket limit/);
      } finally {
        if (previous === undefined) delete process.env.POLLINATE_SOCKET;
        else process.env.POLLINATE_SOCKET = previous;
      }
      const dir = await mkdtemp(join(tmpdir(), "pol-sock-"));
      process.env.POLLINATE_SOCKET = join(dir, "api.sock");
      try {
        const daemon = new PollinateDaemon(store);
        await daemon.start();
        try {
          expect((await call(join(dir, "api.sock"), "GET", "/v1/health")).status).toBe(200);
        } finally {
          await daemon.stop();
        }
      } finally {
        if (previous === undefined) delete process.env.POLLINATE_SOCKET;
        else process.env.POLLINATE_SOCKET = previous;
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("concurrent PUTs all reach every engine and stay there after reload ticks", async () => {
    await withDaemon(
      async ({ socket, daemon }) => {
        slowDeliveryInit(daemon, () => Math.random() * 80);
        const ids = Array.from({ length: 10 }, (_, index) => `t${index}`);
        const puts = await Promise.all(
          ids.map((id, index) =>
            index % 2 === 0
              ? call(socket, "PUT", `/v1/triggers/${id}`, { toml: webhookToml(id, `p-${id}`) })
              : call(socket, "PUT", `/v1/triggers/${id}`, { trigger: { id, source: { kind: "schedule", timing: { type: "every", interval: "1h" } }, action: { kind: "emit", subject: id } } }),
          ),
        );
        expect(puts.map((put) => put.status)).toEqual(ids.map(() => 200));
        const verify = async () => {
          for (const [index, id] of ids.entries()) {
            if (index % 2 === 0) {
              const posted = await fetch(puts[index]!.body.webhook.localUrl, { method: "POST", body: "{}" });
              expect(posted.status, id).toBe(202);
            } else {
              const got = await call(socket, "GET", `/v1/triggers/${id}`);
              expect(Date.parse(got.body.trigger.state.nextFireAt), id).toBeGreaterThan(Date.now());
            }
          }
          expect((await call(socket, "GET", "/v1/health")).body.triggers.total).toBe(10);
        };
        await verify();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await verify();
      },
      DAEMON_CONFIG.replace("triggerReloadMs = 60000", "triggerReloadMs = 20"),
    );
  });

  test("a PUT while a file reload is in flight leaves both triggers live", async () => {
    await withDaemon(
      async ({ socket, store, root, daemon }) => {
        const slow = slowDeliveryInit(daemon, () => 150);
        for (let round = 0; round < 3; round += 1) {
          const reloading = slow.nextInit(`cli${round}`);
          await writeFile(join(root, "triggers", `cli${round}.toml`), webhookToml(`cli${round}`, `cli-${round}`));
          await reloading;
          const put = await call(socket, "PUT", `/v1/triggers/api${round}`, { toml: webhookToml(`api${round}`, `api-${round}`) });
          expect(put.status).toBe(200);
          const port = put.body.webhook.localUrl.split(":")[2].split("/")[0];
          const postBoth = async (when: string) => {
            for (const path of [`cli-${round}`, `api-${round}`]) {
              const posted = await fetch(`http://127.0.0.1:${port}/hook/${path}`, { method: "POST", body: "{}" });
              expect(posted.status, `${when} round ${round} ${path}`).toBe(202);
            }
          };
          await postBoth("right after the PUT");
          await new Promise((resolve) => setTimeout(resolve, 600));
          await postBoth("after reload ticks");
        }
        expect((await store.loadTriggers()).length).toBe(6);
        expect((await call(socket, "GET", "/v1/triggers")).body.triggers).toHaveLength(6);
      },
      DAEMON_CONFIG.replace("triggerReloadMs = 60000", "triggerReloadMs = 200"),
    );
  });

  test("requests during shutdown answer 503 stopping", async () => {
    await withDaemon(async ({ socket, daemon }) => {
      const internals = daemon as unknown as { api: { beginStopping(): void } };
      internals.api.beginStopping();
      expect(await call(socket, "GET", "/v1/health")).toMatchObject({ status: 503, body: { error: { code: "stopping" } } });
    });
  });
});
