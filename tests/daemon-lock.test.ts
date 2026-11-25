import { spawn } from "node:child_process";
import { utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readDaemonRuns } from "../src/daemon-health.js";
import { PollinateDaemon } from "../src/daemon.js";
import { acquireDaemonLock, daemonLockPath, readDaemonLock, refreshDaemonLock, releaseDaemonLock } from "../src/fsx.js";
import type { PollinateStore } from "../src/store.js";
import { trigger, withTempStore } from "./helpers.js";

const DAEMON_CONFIG = `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 50
contextTimeout = "1s"
commandTimeout = "1s"
`;

async function ledgerEvents(store: PollinateStore, event: string): Promise<Array<Record<string, unknown>>> {
  return (await store.readLedger()).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  if (!child.pid) throw new Error("child had no pid");
  return child.pid;
}

async function busyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, server };
}

describe("daemon store lock", () => {
  test("a second daemon on a live store is refused and ledgers daemon.refused", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      const first = new PollinateDaemon(store);
      await first.start();
      try {
        const lockBefore = await readDaemonLock(daemonLockPath(root));
        const second = new PollinateDaemon(store);
        await expect(second.start()).rejects.toMatchObject({ name: "DaemonRefusedError", reason: "locked", holderPid: process.pid });
        expect(await ledgerEvents(store, "pollinate.daemon.refused")).toEqual([expect.objectContaining({ reason: "locked", pid: process.pid })]);
        expect(await ledgerEvents(store, "pollinate.daemon.started")).toHaveLength(1);
        expect(await readDaemonRuns(root)).toHaveLength(1);
        expect((await readDaemonLock(daemonLockPath(root)))?.token).toBe(lockBefore?.token);
      } finally {
        await first.stop();
      }
      expect(await readDaemonLock(daemonLockPath(root))).toBeNull();
    });
  });

  test("a lock left by a dead pid is cleared on start", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      await writeFile(daemonLockPath(root), JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString(), token: "crashed" }));
      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const lock = await readDaemonLock(daemonLockPath(root));
        expect(lock).toMatchObject({ pid: process.pid });
        expect(lock?.token).not.toBe("crashed");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("a lock whose heartbeat is older than 30 s is stale even when its pid is alive", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      const path = daemonLockPath(root);
      await writeFile(path, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), token: "hung" }));
      const old = new Date(Date.now() - 60_000);
      await utimes(path, old, old);
      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        expect(await readDaemonLock(path)).toMatchObject({ pid: process.pid });
      } finally {
        await daemon.stop();
      }
    });
  });

  test("a failed listen releases the lock before any schedule fires", async () => {
    await withTempStore(async (store, root) => {
      const { port, server } = await busyPort();
      try {
        await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG.replace("port = 0", `port = ${port}`));
        await store.saveTrigger(trigger({ id: "every", source: { kind: "schedule", timing: { type: "every", interval: "10ms" } } }));
        const daemon = new PollinateDaemon(store);
        await expect(daemon.start()).rejects.toThrow(/EADDRINUSE/);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await readDaemonLock(daemonLockPath(root))).toBeNull();
        expect(await store.listJobs()).toHaveLength(0);
        expect(await ledgerEvents(store, "pollinate.daemon.started")).toHaveLength(0);
      } finally {
        server.close();
      }
    });
  });

  test("the heartbeat reports a lock taken over by another daemon and release leaves it alone", async () => {
    await withTempStore(async (_store, root) => {
      const attempt = await acquireDaemonLock(root);
      if (!attempt.acquired) throw new Error("expected to acquire the lock");
      expect(await refreshDaemonLock(attempt.lock)).toEqual({ held: true });
      await writeFile(attempt.lock.path, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), token: "other" }));
      expect(await refreshDaemonLock(attempt.lock)).toMatchObject({ held: false, holder: { pid: process.ppid, token: "other" } });
      await releaseDaemonLock(attempt.lock);
      expect((await readDaemonLock(attempt.lock.path))?.token).toBe("other");
    });
  });

  test("daemon run exits 1 within 2 s when the store is locked", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(join(root, "pollinate.toml"), DAEMON_CONFIG);
      const attempt = await acquireDaemonLock(root);
      if (!attempt.acquired) throw new Error("expected to acquire the lock");
      try {
        const started = Date.now();
        const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), "daemon", "run", "--foreground"], {
          env: { ...process.env, POLLINATE_STORE_ROOT: root },
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
        expect(code).toBe(1);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(stderr).toContain(`locked by daemon pid ${process.pid}`);
        expect(await ledgerEvents(store, "pollinate.daemon.refused")).toEqual([expect.objectContaining({ reason: "locked", pid: process.pid })]);
      } finally {
        await releaseDaemonLock(attempt.lock);
      }
    });
  });
});
