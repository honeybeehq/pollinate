import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ledgerPath, PollinateDaemon, PollinateStore, type Job, type JobStatus } from "../src/index.js";
import { withTempStore } from "./helpers.js";

async function waitForLedgerEvent(
  store: PollinateStore,
  event: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const matches = (await store.readLedger())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry: Record<string, unknown>) => entry.event === event);
    const match = matches[matches.length - 1];
    if (match) return match;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ledger event ${event}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function oldTerminalJob(id: string): Job {
  const old = new Date(Date.now() - 60_000).toISOString();
  return {
    id,
    triggerId: "daemon-retention",
    source: "manual",
    status: "completed",
    context: {},
    queuedAt: old,
    completedAt: old,
  };
}

function freshRunningJob(id: string): Job {
  // Deliberately recent (not stale by STALE_JOB_RECOVERY_MS) so daemon startup's
  // own recoverStaleJobs leaves it alone — this test is about gc, not recovery.
  const now = new Date().toISOString();
  return {
    id,
    triggerId: "daemon-retention",
    source: "manual",
    status: "running",
    context: {},
    queuedAt: now,
    startedAt: now,
  };
}

describe("daemon job + ledger retention", () => {
  test("runs jobs gc on the configured retention interval and never touches non-terminal jobs", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 1000
contextTimeout = "1s"
commandTimeout = "1s"

[retention]
jobsMaxAge = "1ms"
jobsKeepLastPerTrigger = 0
jobsGcMs = 20
`,
      );
      await store.saveJob(oldTerminalJob("old-terminal"));
      await store.saveJob(freshRunningJob("still-running"));

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const gc = await waitForLedgerEvent(store, "pollinate.jobs.gc");
        expect(gc.deleted).toBe(1);

        expect(await store.getJob("old-terminal")).toBeNull();
        const stillThere = await store.getJob("still-running");
        expect(stillThere).not.toBeNull();
        expect(stillThere?.status).toBe("running");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("rotates ledger.jsonl once it exceeds retention.ledgerMaxMb", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 1000
contextTimeout = "1s"
commandTimeout = "1s"

[retention]
jobsMaxAge = "14d"
jobsGcMs = 20
ledgerMaxMb = 0.00001
`,
      );

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await waitForLedgerEvent(store, "pollinate.ledger.rotated");
        const stat = await import("node:fs/promises").then((fs) => fs.stat(`${ledgerPath(root)}.1`));
        expect(stat.isFile()).toBe(true);
      } finally {
        await daemon.stop();
      }
    });
  });
});

const QUIET_DAEMON_CONFIG = `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 1000
contextTimeout = "1s"
commandTimeout = "1s"
`;

async function waitForDaemonLog(root: string, text: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const log = await readFile(join(root, "daemon.log"), "utf8").catch(() => "");
    if (log.includes(text)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for daemon.log line "${text}"`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function staleJob(id: string, status: JobStatus, minutesAgo: number): Job {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { id, triggerId: "recovery", source: "manual", status, context: {}, queuedAt: at, startedAt: at };
}

describe("daemon stale job recovery", () => {
  test("does not overwrite a job that finished after the recovery scan listed it", async () => {
    await withTempStore(async (_store, root) => {
      await writeFile(join(root, "pollinate.toml"), QUIET_DAEMON_CONFIG);
      const finished = { ...staleJob("finished-meanwhile", "completed", 10), completedAt: new Date().toISOString() };
      class ScanBeforeFinishStore extends PollinateStore {
        override async listJobs(options: Parameters<PollinateStore["listJobs"]>[0] = {}): Promise<Job[]> {
          if (options.statuses) return [{ ...finished, status: "running", completedAt: undefined }];
          return super.listJobs(options);
        }
      }
      const store = new ScanBeforeFinishStore(root);
      await store.saveJob(finished);

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await waitForDaemonLog(root, "jobs store:");
        expect((await store.getJob("finished-meanwhile"))?.status).toBe("completed");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("keeps recovering the remaining jobs when one job fails", async () => {
    await withTempStore(async (_store, root) => {
      await writeFile(join(root, "pollinate.toml"), QUIET_DAEMON_CONFIG);
      class OneBrokenJobStore extends PollinateStore {
        override async updateJob(id: string, patch: Partial<Job>): Promise<Job> {
          if (id === "broken") throw new Error("disk said no");
          return super.updateJob(id, patch);
        }
      }
      const store = new OneBrokenJobStore(root);
      await store.saveJob(staleJob("broken", "running", 5));
      await store.saveJob(staleJob("healthy", "running", 10));

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await waitForDaemonLog(root, "jobs store:");
        expect((await store.getJob("healthy"))?.status).toBe("errored");
        expect(await readFile(join(root, "daemon.log"), "utf8")).toContain("broken");
      } finally {
        await daemon.stop();
      }
    });
  });
});
