import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { jobsDir, ledgerPath, rotateLedgerIfLarge } from "../src/fsx.js";
import { readJobSummary } from "../src/job-scan.js";
import type { Job, JobStatus } from "../src/types.js";
import { withTempStore } from "./helpers.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function job(overrides: Partial<Job> & { id: string; triggerId: string; status: JobStatus }): Job {
  const now = new Date().toISOString();
  return {
    source: "manual",
    context: {},
    queuedAt: now,
    ...overrides,
  };
}

const DAY = 86_400_000;

const failingReaddir = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = (async (path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
    if (failingReaddir.path && String(path) === failingReaddir.path) {
      throw Object.assign(new Error(`EMFILE: too many open files, scandir '${String(path)}'`), { code: "EMFILE" });
    }
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof actual.readdir;
  return { ...actual, readdir };
});

describe("PollinateStore.garbageCollectJobs", () => {
  test("removes terminal jobs past max-age, keeping the newest N per trigger regardless of age", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "t1-oldest", triggerId: "t1", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      await store.saveJob(job({ id: "t1-older", triggerId: "t1", status: "errored", queuedAt: isoAgo(25 * DAY), completedAt: isoAgo(25 * DAY) }));
      await store.saveJob(job({ id: "t1-newest", triggerId: "t1", status: "cancelled", queuedAt: isoAgo(20 * DAY), completedAt: isoAgo(20 * DAY) }));
      // Different trigger: its own newest-1 floor is independent of t1's — both of
      // t2's jobs are old, but the newer one is still protected by keepLastPerTrigger.
      await store.saveJob(job({ id: "t2-oldest", triggerId: "t2", status: "completed", queuedAt: isoAgo(40 * DAY), completedAt: isoAgo(40 * DAY) }));
      await store.saveJob(job({ id: "t2-newest", triggerId: "t2", status: "completed", queuedAt: isoAgo(25 * DAY), completedAt: isoAgo(25 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 1, liveTriggerIds: new Set(["t1", "t2"]) });

      expect(result.deletedJobIds.sort()).toEqual(["t1-older", "t1-oldest", "t2-oldest"]);
      expect(result.deleted).toBe(3);
      expect(result.perTrigger.t1).toEqual({ deleted: 2, kept: 1 });
      expect(result.perTrigger.t2).toEqual({ deleted: 1, kept: 1 });

      expect(await store.getJob("t1-newest")).not.toBeNull();
      expect(await store.getJob("t1-oldest")).toBeNull();
      expect(await store.getJob("t1-older")).toBeNull();
      expect(await store.getJob("t2-newest")).not.toBeNull();
      expect(await store.getJob("t2-oldest")).toBeNull();
    });
  });

  test("never removes queued, resolving-context, or running jobs no matter how old", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "still-queued", triggerId: "t1", status: "queued", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "still-running", triggerId: "t1", status: "running", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "resolving", triggerId: "t1", status: "resolving-context", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "old-terminal", triggerId: "t1", status: "completed", queuedAt: isoAgo(90 * DAY), completedAt: isoAgo(90 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 1 });

      expect(result.deletedJobIds).toEqual(["old-terminal"]);
      expect(await store.getJob("still-queued")).not.toBeNull();
      expect(await store.getJob("still-running")).not.toBeNull();
      expect(await store.getJob("resolving")).not.toBeNull();
      expect(await store.getJob("old-terminal")).toBeNull();
      // Active jobs never enter the terminal-only per-trigger breakdown.
      expect(result.perTrigger.t1).toEqual({ deleted: 1, kept: 0 });
    });
  });

  test("dry-run reports what would be removed without deleting anything", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "would-go", triggerId: "t1", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      await store.saveJob(job({ id: "would-stay", triggerId: "t1", status: "completed", queuedAt: isoAgo(1 * DAY), completedAt: isoAgo(1 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 0, dryRun: true });

      expect(result.deletedJobIds).toEqual(["would-go"]);
      expect(result.prunedJobUuids).toBe(0);
      // Nothing was actually unlinked.
      expect(await store.getJob("would-go")).not.toBeNull();
      expect(await store.getJob("would-stay")).not.toBeNull();

      const rerun = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 0 });
      expect(rerun.deletedJobIds).toEqual(["would-go"]);
      expect(await store.getJob("would-go")).toBeNull();
    });
  });

  test("rejects a non-positive retention window", async () => {
    await withTempStore(async (store) => {
      await expect(store.garbageCollectJobs({ terminalOlderThanDays: 0 })).rejects.toThrow(/terminalOlderThanDays/);
    });
  });
});

describe("job store bounds", () => {
  test("caps terminal jobs per trigger regardless of age and keeps the newest", async () => {
    await withTempStore(async (store) => {
      for (let i = 0; i < 6; i += 1) {
        await store.saveJob(job({ id: `chatty-${i}`, triggerId: "chatty", status: "completed", queuedAt: isoAgo((10 - i) * 60_000), completedAt: isoAgo((10 - i) * 60_000) }));
      }
      await store.saveJob(job({ id: "chatty-live", triggerId: "chatty", status: "running", queuedAt: isoAgo(DAY) }));
      await store.saveJob(job({ id: "quiet-0", triggerId: "quiet", status: "completed", completedAt: isoAgo(60_000) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 50, maxPerTrigger: 2 });

      expect(result.deletedJobIds.sort()).toEqual(["chatty-0", "chatty-1", "chatty-2", "chatty-3"]);
      expect(result.deletedByCap).toBe(4);
      expect(result.perTrigger.chatty).toEqual({ deleted: 4, kept: 2 });
      expect(result.kept).toBe(4);
      expect((await store.listJobs({ triggerId: "chatty" })).map((j) => j.id)).toEqual(["chatty-5", "chatty-4", "chatty-live"]);
    });
  });

  test("jobs of removed triggers age out without the keep-last floor, and a total cap bounds distinct one-fire triggers", async () => {
    await withTempStore(async (store) => {
      await store.addTriggerFromToml(`[trigger]\nid = "live"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n`);
      await store.saveJob(job({ id: "live-old", triggerId: "live", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      await store.saveJob(job({ id: "gone-old", triggerId: "gone", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      for (let i = 0; i < 40; i += 1) {
        await store.saveJob(job({ id: `once-${i}`, triggerId: `once-${i}`, status: "completed", queuedAt: isoAgo((100 - i) * 60_000), completedAt: isoAgo((100 - i) * 60_000) }));
      }

      const byAge = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 50, maxPerTrigger: 500 });
      expect(byAge.deletedJobIds).toEqual(["gone-old"]);

      const byTotal = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 50, maxPerTrigger: 500, maxTotal: 10 });
      const remaining = (await store.listJobs({ last: 100 })).map((j) => j.id).sort();
      expect(remaining).toEqual(Array.from({ length: 10 }, (_, i) => `once-${30 + i}`).sort());
      expect(byTotal.deletedByCap).toBe(31);
    });
  });

  test("summaries come from the file head for new files and from a full parse for old key order", async () => {
    await withTempStore(async (store, root) => {
      const big = { blob: "x".repeat(20_000) };
      await store.saveJob(job({ id: "AP.new", uuid: "0123456789abcdef0123456789abcdef", triggerId: "ap", status: "completed", batch: [big], completedAt: isoAgo(5) }));
      const written = await readFile(join(jobsDir(root), "AP.new.json"), "utf8");
      expect(Object.keys(JSON.parse(written)).slice(0, 4)).toEqual(["id", "uuid", "triggerId", "source"]);

      const legacy = { id: "AP.old", triggerId: "ap", source: "manual", status: "running", context: big, queuedAt: isoAgo(5) };
      await writeFile(join(jobsDir(root), "AP.old.json"), `${JSON.stringify(legacy, null, 2)}\n`);

      expect(await readJobSummary(join(jobsDir(root), "AP.new.json"), "AP.new.json")).toMatchObject({ id: "AP.new", status: "completed", uuid: "0123456789abcdef0123456789abcdef" });
      expect(await readJobSummary(join(jobsDir(root), "AP.old.json"), "AP.old.json")).toMatchObject({ id: "AP.old", status: "running", queuedAt: legacy.queuedAt });
      expect((await store.getJob("0123"))?.id).toBe("AP.new");
    });
  });

  test("gc drops job-id index entries whose job files are gone", async () => {
    await withTempStore(async (store, root) => {
      const kept = "11111111111111111111111111111111";
      const orphan = "22222222222222222222222222222222";
      await store.saveJob(job({ id: "KE.111", uuid: kept, triggerId: "keep", status: "completed", completedAt: isoAgo(5) }));
      await writeFile(join(root, "state", "job-id-index.json"), JSON.stringify({ used: [kept, orphan] }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14 });

      expect(result.prunedJobUuids).toBe(1);
      expect(JSON.parse(await readFile(join(root, "state", "job-id-index.json"), "utf8")).used).toEqual([kept]);
    });
  });
});

describe("job store failure handling", () => {
  test("a sweep that cannot list the trigger folder fails instead of treating every trigger as removed", async () => {
    await withTempStore(async (store, root) => {
      await store.addTriggerFromToml(`[trigger]\nid = "t1"\n[trigger.source]\nkind = "manual"\n[trigger.action]\nkind = "emit"\nsubject = "x"\n`);
      await store.saveJob(job({ id: "t1-protected", triggerId: "t1", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      failingReaddir.path = join(root, "triggers");
      try {
        await expect(store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 50 })).rejects.toThrow(/EMFILE/);
      } finally {
        failingReaddir.path = undefined;
      }
      expect(await store.getJob("t1-protected")).not.toBeNull();
    });
  });

  test("a malformed job file over 4 KB is skipped by listings and the sweep instead of failing them", async () => {
    await withTempStore(async (store, root) => {
      await store.saveJob(job({ id: "good", triggerId: "t1", status: "completed", completedAt: isoAgo(5) }));
      await writeFile(join(jobsDir(root), "broken.json"), `{\n  "id": "\\x",\n  "context": "${"y".repeat(5_000)}"\n}\n`);

      expect((await store.listJobs({ last: 10 })).map((j) => j.id)).toEqual(["good"]);
      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14 });
      expect(result.kept).toBe(1);
    });
  });
});

describe("PollinateStore.listJobs statuses filter", () => {
  test("filters before collecting, and matches the equivalent single-status query", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "queued-1", triggerId: "t1", status: "queued" }));
      await store.saveJob(job({ id: "running-1", triggerId: "t1", status: "running" }));
      await store.saveJob(job({ id: "done-1", triggerId: "t1", status: "completed", completedAt: new Date().toISOString() }));

      const nonTerminal = await store.listJobs({ statuses: ["queued", "resolving-context", "running"] });
      expect(nonTerminal.map((j) => j.id).sort()).toEqual(["queued-1", "running-1"]);

      const onlyQueued = await store.listJobs({ statuses: ["queued"] });
      expect(onlyQueued.map((j) => j.id)).toEqual(["queued-1"]);
      expect(await store.listJobs({ status: "queued" })).toEqual(onlyQueued);
    });
  });
});

describe("rotateLedgerIfLarge", () => {
  test("leaves a ledger under the size cap untouched", async () => {
    await withTempStore(async (store, root) => {
      await store.appendLedger({ event: "pollinate.test.small" });
      const rotated = await rotateLedgerIfLarge(root, 64);
      expect(rotated).toBe(false);
      expect((await store.readLedger()).join("\n")).toContain("pollinate.test.small");
    });
  });

  test("rotates ledger.jsonl to ledger.jsonl.1 once it exceeds the cap, replacing any prior generation", async () => {
    await withTempStore(async (store, root) => {
      await store.appendLedger({ event: "pollinate.test.first-generation" });
      // Force a rotation with a cap so small any content trips it.
      const firstRotation = await rotateLedgerIfLarge(root, 0.00001);
      expect(firstRotation).toBe(2);

      const rotatedContent = await stat(`${ledgerPath(root)}.1`);
      expect(rotatedContent.isFile()).toBe(true);

      // Lazily recreated on the next append; old content isn't visible via readLedger.
      await store.appendLedger({ event: "pollinate.test.second-generation" });
      const lines = await store.readLedger();
      expect(lines.join("\n")).toContain("pollinate.test.second-generation");
      expect(lines.join("\n")).not.toContain("pollinate.test.first-generation");

      // Rotating again replaces the previous .1 generation instead of erroring.
      const secondRotation = await rotateLedgerIfLarge(root, 0.00001);
      expect(secondRotation).toBe(3);
      const replaced = await stat(`${ledgerPath(root)}.1`);
      expect(replaced.isFile()).toBe(true);
    });
  });

  test("is a no-op when ledger.jsonl does not exist yet", async () => {
    await withTempStore(async (_store, root) => {
      await expect(rotateLedgerIfLarge(root, 1)).resolves.toBe(false);
    });
  });
});
