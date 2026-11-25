import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PollinateDaemon } from "../src/daemon.js";
import type { PollinateStore } from "../src/store.js";
import type { Job, Trigger } from "../src/types.js";
import { trigger, withTempStore } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "dist", "cli.js");

const DAEMON_CONFIG = `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 50
triggerReloadMs = 60000
contextTimeout = "1s"
commandTimeout = "5s"
`;

type Run = { code: number; stdout: string; stderr: string; json: any };

async function pol(root: string, ...args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, POLLINATE_STORE_ROOT: root };
  delete env.POLLINATE_SOCKET;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args, "--json"], { env });
    return { code: 0, stdout, stderr, json: JSON.parse(stdout) };
  } catch (error) {
    const failed = error as { code?: number; stdout: string; stderr: string };
    return { code: failed.code ?? 1, stdout: failed.stdout, stderr: failed.stderr, json: failed.stderr.trim() ? JSON.parse(failed.stderr) : undefined };
  }
}

async function withDaemon<T>(fn: (ctx: { store: PollinateStore; root: string }) => Promise<T>, seed: Trigger[] = []): Promise<T> {
  return withTempStore(async (store, root) => {
    await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
    for (const seeded of seed) await store.saveTrigger(seeded);
    const daemon = new PollinateDaemon(store);
    await daemon.start();
    try {
      return await fn({ store, root });
    } finally {
      await daemon.stop();
    }
  });
}

async function withFakeDaemon<T>(root: string, answer: (request: http.IncomingMessage, response: http.ServerResponse) => void, fn: (requests: string[]) => Promise<T>): Promise<T> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => answer(request, response));
  });
  await new Promise<void>((resolve) => server.listen(join(root, "pollinated.sock"), resolve));
  try {
    return await fn(requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function ledgerEvents(root: string): Promise<string[]> {
  const text = await readFile(join(root, "ledger.jsonl"), "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

async function writeToml(root: string, name: string, text: string): Promise<string> {
  const path = join(root, `${name}.toml`);
  await writeFile(path, text);
  return path;
}

const WEBHOOK_TOML = `
[trigger]
id = "inbox"
[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "inbox"
[trigger.action]
kind = "emit"
subject = "test.inbox"
`;

function gatedToml(gate: string): string {
  return `
[trigger]
id = "gated"
[trigger.source]
kind = "manual"
[trigger.delivery]
maxConcurrent = 1
[trigger.action]
kind = "command"
command = "while [ ! -e '${gate}' ]; do sleep 0.02; done"
timeout = "5s"
`;
}

const BROKEN_POLL_TOML = `
[trigger]
id = "broken"
[trigger.source]
kind = "poll"
[trigger.source.poll]
interval = "1m"
[trigger.source.poll.fetch]
kind = "command"
command = "echo nope >&2; exit 3"
[trigger.source.poll.cursor]
strategy = "hash"
[trigger.action]
kind = "emit"
subject = "test.broken"
`;

describe("pol through the daemon socket", () => {
  test("add, trigger, enable, disable, job cancel and remove go through the daemon with no file reload", async () => {
    await withDaemon(async ({ store, root }) => {
      const added = await pol(root, "add", await writeToml(root, "inbox", WEBHOOK_TOML));
      expect(added.json).toMatchObject({ id: "inbox", via: "daemon", created: true, webhook: { path: "/hook/inbox" } });
      const posted = await fetch(added.json.webhook.localUrl, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(posted.status).toBe(202);

      const gate = join(root, "gate");
      expect((await pol(root, "add", await writeToml(root, "gated", gatedToml(gate)))).json).toMatchObject({ id: "gated", via: "daemon" });
      const first = pol(root, "trigger", "gated");
      const second = pol(root, "trigger", "gated");
      await waitForJob(store, "gated", "running");
      const queued = await waitForJob(store, "gated", "queued");

      const cancelled = await pol(root, "job", "cancel", queued.id);
      expect(cancelled.json).toMatchObject({ id: queued.id, status: "cancelled", via: "daemon" });
      await writeFile(gate, "");
      const outcomes = [(await first).json, (await second).json].sort((a, b) => a.status.localeCompare(b.status));
      expect(outcomes).toMatchObject([
        { id: queued.id, status: "cancelled", via: "daemon" },
        { triggerId: "gated", status: "completed", via: "daemon" },
      ]);

      expect((await pol(root, "disable", "inbox")).json).toMatchObject({ id: "inbox", enabled: false, via: "daemon" });
      expect((await fetch(added.json.webhook.localUrl, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await pol(root, "enable", "inbox")).json).toMatchObject({ id: "inbox", enabled: true, via: "daemon" });
      expect((await fetch(added.json.webhook.localUrl, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(202);

      expect((await pol(root, "remove", "inbox")).json).toEqual({ removed: "inbox", via: "daemon" });
      expect((await fetch(added.json.webhook.localUrl, { method: "POST", body: "{}" })).status).toBe(404);
      expect(await store.getTrigger("inbox")).toBeNull();
      expect(await ledgerEvents(root)).not.toContain("pollinate.daemon.triggers_reloaded");
    });
  });

  test("trigger maps a held activation and a duplicate delivery id to clear answers", async () => {
    await withDaemon(
      async ({ root }) => {
      const held = await pol(root, "trigger", "calm");
      expect(held.code).toBe(0);
      expect(held.json).toMatchObject({ job: null, held: true, trigger_id: "calm", delivery_mode: "debounced", via: "daemon" });

      expect((await pol(root, "trigger", "once", "--delivery-id", "d-1")).json).toMatchObject({ triggerId: "once", via: "daemon" });
      const duplicate = await pol(root, "trigger", "once", "--delivery-id", "d-1");
      expect(duplicate.code).toBe(0);
      expect(duplicate.json).toEqual({ duplicate: true, trigger_id: "once", delivery_id: "once:d-1", via: "daemon" });
      },
      [trigger({ id: "calm", delivery: { mode: { strategy: "debounced", quietPeriod: "1h" }, maxConcurrent: 1 } }), trigger({ id: "once" })],
    );
  });

  test("API errors are reported with exit 1 and the CLI error shape; a disabled trigger fires through files as today", async () => {
    await withDaemon(async ({ store, root }) => {
      const refused = await pol(root, "add", await writeToml(root, "broken", BROKEN_POLL_TOML));
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({ error: expect.stringContaining("first poll check failed"), code: "poll_failed" });
      expect(await store.getTrigger("broken")).toBeNull();

      const missing = await pol(root, "job", "cancel", "nope");
      expect(missing.code).toBe(1);
      expect(missing.json).toMatchObject({ code: "not_found" });

      const gate = join(root, "gate");
      await writeFile(gate, "");
      await pol(root, "add", await writeToml(root, "gated", gatedToml(gate)));
      await pol(root, "disable", "gated");
      const disabled = await pol(root, "trigger", "gated");
      expect(disabled.json).toMatchObject({ triggerId: "gated", status: "completed", via: "files" });
      expect(await store.listJobs({ triggerId: "gated" })).toHaveLength(1);
    });
  });
});

describe("pol with no daemon", () => {
  test("every command works through files when no socket exists", async () => {
    await withTempStore(async (store, root) => {
      expect((await pol(root, "add", await writeToml(root, "broken", BROKEN_POLL_TOML))).json).toMatchObject({ id: "broken", via: "files" });
      expect((await pol(root, "disable", "broken")).json).toMatchObject({ enabled: false, via: "files" });
      expect((await pol(root, "enable", "broken")).json).toMatchObject({ enabled: true, via: "files" });
      expect((await pol(root, "remove", "broken")).json).toEqual({ removed: "broken", via: "files" });

      await store.saveTrigger(trigger({ id: "once" }));
      expect((await pol(root, "trigger", "once")).json).toMatchObject({ triggerId: "once", status: "completed", via: "files" });
      expect((await pol(root, "trigger", "once", "--delivery-id", "x")).json).toMatchObject({ status: "completed", via: "files" });
      expect((await pol(root, "trigger", "once", "--delivery-id", "x")).json).toEqual({ duplicate: true, trigger_id: "once", delivery_id: "once:x", via: "files" });

      await store.saveJob({ id: "QQ.001", triggerId: "once", source: "manual", status: "queued", context: {}, queuedAt: new Date().toISOString() });
      expect((await pol(root, "job", "cancel", "QQ.001")).json).toMatchObject({ id: "QQ.001", status: "cancelled", via: "files" });
    });
  });

  test("a stale socket file falls back to files", async () => {
    await withTempStore(async (store, root) => {
      await leaveStaleSocket(join(root, "pollinated.sock"));
      await store.saveTrigger(trigger({ id: "once" }));
      expect((await pol(root, "trigger", "once")).json).toMatchObject({ status: "completed", via: "files" });
      expect((await pol(root, "disable", "once")).json).toMatchObject({ enabled: false, via: "files" });
    });
  });

  test("a daemon answering 503 stopping or 501 unsupported falls back to files", async () => {
    await withTempStore(async (store, root) => {
      await store.saveTrigger(trigger({ id: "once" }));
      for (const [status, code] of [
        [503, "stopping"],
        [501, "unsupported"],
      ] as const) {
        await withFakeDaemon(
          root,
          (_request, response) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code, message: code } }));
          },
          async (requests) => {
            expect((await pol(root, "trigger", "once")).json).toMatchObject({ status: "completed", via: "files" });
            expect(requests).toEqual(["POST /v1/triggers/once/fire"]);
          },
        );
      }
      expect(await store.listJobs({ triggerId: "once" })).toHaveLength(2);
    });
  });

  test("a daemon that dies after taking the request is reported, never fired again through files", async () => {
    await withTempStore(async (store, root) => {
      await store.saveTrigger(trigger({ id: "once" }));
      await withFakeDaemon(
        root,
        (request) => request.socket.destroy(),
        async (requests) => {
          const fired = await pol(root, "trigger", "once");
          expect(fired.code).toBe(1);
          expect(fired.json).toMatchObject({ code: "interrupted", error: expect.stringContaining("may have taken effect") });
          expect(requests).toEqual(["POST /v1/triggers/once/fire"]);
        },
      );
      await withFakeDaemon(
        root,
        (_request, response) => {
          response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
          response.write('{"job":');
          setTimeout(() => response.socket?.destroy(), 50);
        },
        async () => {
          expect((await pol(root, "trigger", "once")).json).toMatchObject({ code: "interrupted" });
        },
      );
      expect(await store.listJobs({ triggerId: "once" })).toHaveLength(0);
    });
  });
});

async function waitForJob(store: PollinateStore, triggerId: string, status: Job["status"]): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const [job] = await store.listJobs({ triggerId, status });
    if (job) return job;
    if (Date.now() - start > 5_000) throw new Error(`no ${status} job for ${triggerId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
