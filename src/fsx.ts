import { chmod, link, mkdir, open, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function storeRoot(): string {
  return process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate");
}

export function triggerDir(root = storeRoot()): string {
  return join(root, "triggers");
}

export function stateDir(root = storeRoot()): string {
  return join(root, "state");
}

export function jobsDir(root = storeRoot()): string {
  return join(root, "jobs");
}

export function routerBindingsDir(root = storeRoot()): string {
  return join(stateDir(root), "router-bindings");
}

export function routerPluginsDir(root = storeRoot()): string {
  return join(root, "router-plugins");
}

export function ledgerPath(root = storeRoot()): string {
  return join(root, "ledger.jsonl");
}

export function daemonLogPath(root = storeRoot()): string {
  return join(root, "daemon.log");
}

/**
 * Rotates ledger.jsonl to ledger.jsonl.1 (replacing any previous generation)
 * once it exceeds maxMb. `rename` atomically replaces the destination on
 * POSIX, and any append already in flight keeps writing to the descriptor it
 * opened (which now lives at the rotated name) — appendTextLine opens,
 * writes, and closes per call, so nothing is lost mid-write. The next
 * appendJsonLine call lazily recreates ledger.jsonl via its `mkdir` + `open`
 * "a" semantics.
 */
export async function rotateLedgerIfLarge(root: string, maxMb: number): Promise<boolean> {
  if (!Number.isFinite(maxMb) || maxMb <= 0) return false;
  const path = ledgerPath(root);
  const info = await stat(path).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (!info || info.size <= maxMb * 1024 * 1024) return false;
  await rename(path, `${path}.1`);
  return true;
}

export function daemonLockPath(root = storeRoot()): string {
  return join(stateDir(root), "daemon.lock");
}

export const STORE_SCHEMA = 1;
export const MAX_SOCKET_PATH_BYTES = 103;

export function apiSocketPath(root = storeRoot()): string {
  return process.env.POLLINATE_SOCKET || join(root, "pollinated.sock");
}

export function storeMetaPath(root = storeRoot()): string {
  return join(stateDir(root), "store.json");
}

export class StoreSchemaError extends Error {
  constructor(
    readonly found: number,
    readonly path: string,
  ) {
    super(`store schema ${found} in ${path} is newer than this Pollinate supports (schema ${STORE_SCHEMA}); upgrade Pollinate or use another store`);
    this.name = "StoreSchemaError";
  }
}

export async function ensureStoreSchema(root = storeRoot()): Promise<number> {
  const path = storeMetaPath(root);
  const text = await readTextOrNull(path);
  if (text === null || text.trim() === "") {
    await writeJson(path, { schema: STORE_SCHEMA });
    return STORE_SCHEMA;
  }
  let schema: unknown;
  try {
    schema = (JSON.parse(text) as { schema?: unknown }).schema;
  } catch {
    throw new Error(`store metadata ${path} is not valid JSON; fix or remove it`);
  }
  if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1) throw new Error(`store metadata ${path} has no valid "schema"; fix or remove it`);
  if (schema > STORE_SCHEMA) throw new StoreSchemaError(schema, path);
  return schema;
}

export function daemonConfigPath(root = storeRoot()): string {
  return join(root, "pollinate.toml");
}

export async function ensureStore(root = storeRoot()): Promise<void> {
  await mkdir(triggerDir(root), { recursive: true, mode: 0o700 });
  await mkdir(stateDir(root), { recursive: true, mode: 0o700 });
  await mkdir(jobsDir(root), { recursive: true, mode: 0o700 });
  await mkdir(routerBindingsDir(root), { recursive: true, mode: 0o700 });
  await mkdir(routerPluginsDir(root), { recursive: true, mode: 0o700 });
}

export async function atomicWriteFile(path: string, data: string | Buffer, options: { mode?: number; sync?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mode = options.mode ?? 0o600;
  const sync = options.sync ?? false;
  const tmp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(tmp, "w", mode);
    try {
      await handle.writeFile(data);
      if (sync) await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await chmod(path, mode).catch(() => undefined);
  } finally {
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  const text = await readTextOrNull(path);
  if (text === null || text.trim() === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    await quarantineCorruptJson(path, error);
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown, options: { sync?: boolean } = {}): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, sync: options.sync });
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendTextLine(path, JSON.stringify(value));
}

export async function appendTextLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${line}\n`, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600).catch(() => undefined);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

const LOCK_STALE_MS = 15 * 60_000;
const LOCK_HEARTBEAT_MS = 10_000;

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let acquired = false;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${token}\n${new Date().toISOString()}\n`, "utf8");
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(path);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await handle?.close();
      if (handle && !acquired) await unlinkOwnedLock(path, token);
    }
  }

  const heartbeat = setInterval(() => {
    void refreshOwnedLock(path, token);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await unlinkOwnedLock(path, token);
  }
}

async function removeStaleLock(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path).catch(() => undefined);
}

async function refreshOwnedLock(path: string, token: string): Promise<void> {
  const current = await readLockToken(path);
  if (current !== token) return;
  const now = new Date();
  await utimes(path, now, now).catch(() => undefined);
}

async function unlinkOwnedLock(path: string, token: string): Promise<void> {
  const current = await readLockToken(path);
  if (current === token) await unlink(path).catch(() => undefined);
}

async function readLockToken(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/, 1)[0];
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export const DAEMON_LOCK_HEARTBEAT_MS = 10_000;
export const DAEMON_LOCK_STALE_MS = 30_000;
const DAEMON_LOCK_ATTEMPTS = 5;

export type DaemonLock = { path: string; pid: number; startedAt: string; token: string };
export type DaemonLockHolder = { pid: number | null; startedAt: string | null; heartbeatAt: string; token: string | null; raw: string; mtimeMs: number };
export type DaemonLockAttempt = { acquired: true; lock: DaemonLock } | { acquired: false; holder: DaemonLockHolder | null };
export type DaemonLockCheck = { held: true } | { held: false; holder: DaemonLockHolder | null };

export async function acquireDaemonLock(root: string, staleMs = DAEMON_LOCK_STALE_MS): Promise<DaemonLockAttempt> {
  const lock: DaemonLock = { path: daemonLockPath(root), pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };
  await mkdir(dirname(lock.path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < DAEMON_LOCK_ATTEMPTS; attempt += 1) {
    if (await createDaemonLockFile(lock)) return { acquired: true, lock };
    const holder = await readDaemonLock(lock.path);
    if (!holder) continue;
    if (!isDaemonLockStale(holder, staleMs)) return { acquired: false, holder };
    await removeUnchangedDaemonLock(lock.path, holder);
  }
  return { acquired: false, holder: await readDaemonLock(lock.path) };
}

export async function refreshDaemonLock(lock: DaemonLock): Promise<DaemonLockCheck> {
  const holder = await readDaemonLock(lock.path);
  if (!holder) {
    if (await createDaemonLockFile(lock)) return { held: true };
    const current = await readDaemonLock(lock.path);
    return current?.token === lock.token ? { held: true } : { held: false, holder: current };
  }
  if (holder.token !== lock.token) return { held: false, holder };
  const now = new Date();
  await utimes(lock.path, now, now);
  return { held: true };
}

export async function releaseDaemonLock(lock: DaemonLock): Promise<void> {
  const holder = await readDaemonLock(lock.path);
  if (holder?.token === lock.token) await unlink(lock.path).catch(() => undefined);
}

export async function readDaemonLock(path: string): Promise<DaemonLockHolder | null> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed = parseDaemonLock(raw);
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      token: typeof parsed.token === "string" ? parsed.token : null,
      heartbeatAt: info.mtime.toISOString(),
      raw,
      mtimeMs: info.mtimeMs,
    };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export function isDaemonLockStale(holder: DaemonLockHolder, staleMs = DAEMON_LOCK_STALE_MS, now = Date.now()): boolean {
  if (now - holder.mtimeMs > staleMs) return true;
  return holder.pid !== null && !processAlive(holder.pid);
}

function parseDaemonLock(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function createDaemonLockFile(lock: DaemonLock): Promise<boolean> {
  const tmp = join(dirname(lock.path), `.daemon.lock.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ pid: lock.pid, startedAt: lock.startedAt, token: lock.token })}\n`, { mode: 0o600 });
  try {
    await link(tmp, lock.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function removeUnchangedDaemonLock(path: string, judged: DaemonLockHolder): Promise<void> {
  const current = await readDaemonLock(path);
  if (!current || current.raw !== judged.raw || current.mtimeMs !== judged.mtimeMs) return;
  await unlink(path).catch((error) => {
    if (!isEnoent(error)) throw error;
  });
}

async function quarantineCorruptJson(path: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${suffix}`;
  try {
    await rename(path, target);
    console.warn(`[pollinate] Corrupt JSON at ${path}: ${message}; moved to ${target}`);
  } catch (renameError) {
    if (isEnoent(renameError)) return;
    const renameMessage = renameError instanceof Error ? renameError.message : String(renameError);
    console.warn(`[pollinate] Corrupt JSON at ${path}: ${message}; failed to quarantine: ${renameMessage}`);
  }
}
