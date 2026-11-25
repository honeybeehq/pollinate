import { describe, expect, test } from "vitest";
import { ActionExecutor, ActionFailure, isValidHiveHandle } from "../src/actions.js";
import { pathExists } from "../src/fsx.js";
import { join } from "node:path";
import { installHiveStub, withTempStore } from "./helpers.js";

describe("isValidHiveHandle", () => {
  test("accepts hive-style handles and rejects shell metacharacters", () => {
    expect(isValidHiveHandle("pr-123")).toBe(true);
    expect(isValidHiveHandle("colony:bee.2")).toBe(true);
    expect(isValidHiveHandle("warning:")).toBe(false);
    expect(isValidHiveHandle("two words")).toBe(false);
    expect(isValidHiveHandle("a;b")).toBe(false);
    expect(isValidHiveHandle(undefined)).toBe(false);
  });
});

describe("ActionExecutor honeybee argv execution", () => {
  test("passes webhook-derived strings as single arguments, never through a shell", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const marker = join(root, "pwned");
        const message = `PR title with '; touch ${marker}; echo ' and $(touch ${marker}) and \`touch ${marker}\``;
        await executor.executeAction({ kind: "honeybee", run: "send", target: "bee-1", message });

        expect(await pathExists(marker)).toBe(false);
        expect(await hive.log()).toContain(`send bee-1 ${message}`);
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn extracts the handle from hive stdout and sends the initial message", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const result = await executor.executeAction({
          kind: "honeybee",
          run: "spawn",
          bee: "codex",
          name: "review-1",
          message: "start reviewing",
        });
        expect(result.handle).toBe("review-1");
        const log = await hive.log();
        expect(log).toContain("spawn review-1 --agent codex --no-parent");
        expect(log).toContain("send review-1 start reviewing");
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn fails loudly when hive output contains no parsable handle", async () => {
    await withTempStore(async (store, root) => {
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "$@" >> "${hiveLog}"\necho "!! totally not a handle !!"\ncat >/dev/null\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        await expect(
          executor.executeAction({ kind: "honeybee", run: "spawn", bee: "codex" }),
        ).rejects.toThrow(/did not return a parsable target handle/);
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn falls back to the rendered --name when stdout is unparsable but the name is a valid handle", async () => {
    await withTempStore(async (store, root) => {
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "$@" >> "${hiveLog}"\necho "!! noise !!"\ncat >/dev/null\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const result = await executor.executeAction({ kind: "honeybee", run: "spawn", bee: "codex", name: "fallback-1" });
        expect(result.handle).toBe("fallback-1");
      } finally {
        hive.restore();
      }
    });
  });

  test("nonzero hive exits surface the stderr in the error", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "no such bee" >&2\ncat >/dev/null\nexit 3\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        await expect(
          executor.executeAction({ kind: "honeybee", run: "kill", target: "ghost" }),
        ).rejects.toThrow(/hive stop exited 3: no such bee/);
      } finally {
        hive.restore();
      }
    });
  });

  test("sequence actions collect spawn handles and honor primary", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const result = await executor.executeAction({
          kind: "sequence",
          mode: "parallel",
          primary: "b",
          actions: [
            { id: "a", action: { kind: "honeybee", run: "spawn", bee: "codex", name: "seq-a" } },
            { id: "b", action: { kind: "honeybee", run: "spawn", bee: "claude", name: "seq-b" } },
          ],
        });
        expect(result.handles).toEqual({ a: "seq-a", b: "seq-b" });
        expect(result.handle).toBe("seq-b");
      } finally {
        hive.restore();
      }
    });
  });
});

describe("ActionExecutor hive contract", () => {
  const execution = { triggerId: "t", deliveryId: "t:d1", attempt: 1 };

  test("send passes automation sender, urgency and the delivery idempotency key, and shields a leading dash", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        await executor.executeAction({ kind: "honeybee", run: "send", target: "bee-1", message: "--- note", urgency: "now" }, undefined, execution);
        expect(await hive.log()).toContain("send bee-1  --- note --sender-kind automation --urgency now --idempotency-key t:d1:send --json");
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn keys the spawn and the seed message separately and never inherits a parent", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        await executor.executeAction(
          { kind: "honeybee", run: "spawn", agent: "codex", name: "r-1", account: "work", tags: ["a"], colony: "ops", title: "T", message: "go" },
          undefined,
          execution,
        );
        const log = await hive.log();
        expect(log).toContain("spawn r-1 --agent codex --no-parent --idempotency-key t:d1:spawn --json --account work --title T --tag a --tag colony=ops");
        expect(log).toContain("send r-1 go --sender-kind automation --idempotency-key t:d1:seed --json");
      } finally {
        hive.restore();
      }
    });
  });

  test("a hive --json error becomes '<verb>: <code>: <message>' with retry codes and a named binary on protocol_mismatch", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho '{"error":{"code":"protocol_mismatch","message":"old client"}}'\ncat >/dev/null\nexit 1\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const failure = await executor.executeAction({ kind: "honeybee", run: "send", target: "b", message: "m" }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ActionFailure);
        expect((failure as ActionFailure).message).toContain(`hive send: protocol_mismatch: old client (hive binary: ${join(hive.binDir, "hive")}`);
        expect((failure as ActionFailure).codes).toEqual(["protocol_mismatch"]);
        expect((failure as ActionFailure).hiveError).toMatchObject({ code: "protocol_mismatch", binary: join(hive.binDir, "hive") });
      } finally {
        hive.restore();
      }
    });
  });

  test("stop treats bee_not_found as already stopped", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho '{"error":{"code":"bee_not_found","message":"bee not found: ghost"}}'\ncat >/dev/null\nexit 1\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 10_000 });
        const result = await executor.executeAction({ kind: "honeybee", run: "stop", target: "ghost" });
        expect(result).toMatchObject({ stopped: false, alreadyStopped: true });
      } finally {
        hive.restore();
      }
    });
  });
});
