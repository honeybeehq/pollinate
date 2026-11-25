import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withTempStore } from "./helpers.js";

const REMOVED_KIND_TRIGGER = `[trigger]
id = "old-buz"

[trigger.source]
kind = "manual"

[trigger.action]
kind = "honeybee"
run = "buz"
target = "bee"
message = "hi"
`;

describe("invalid trigger files", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test("are skipped and reported once per file change", async () => {
    await withTempStore(async (store, root) => {
      const path = join(root, "triggers", "old-buz.toml");
      await writeFile(path, REMOVED_KIND_TRIGGER);
      const invalidEvents = async () =>
        (await store.readLedger()).map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === "pollinate.trigger.invalid");

      for (let i = 0; i < 3; i += 1) expect(await store.loadTriggers()).toEqual([]);
      expect(await invalidEvents()).toHaveLength(1);
      expect((await invalidEvents())[0]).toMatchObject({ trigger_id: "old-buz", path, error: expect.stringContaining('use run = "send" instead') });
      expect(warn).toHaveBeenCalledTimes(1);

      const later = new Date(Date.now() + 5_000);
      await utimes(path, later, later);
      for (let i = 0; i < 3; i += 1) await store.loadTriggers();
      expect(await invalidEvents()).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
