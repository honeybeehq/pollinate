import { access, constants, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { PollinateStore, TRIGGER_STATE_FILES, type TriggerStateFile } from "./store.js";
import { DEFAULT_DAEMON_CONFIG, idFromPath, parseTriggerToml } from "./config.js";
import { crashLoopStatus, readDaemonRuns } from "./daemon-health.js";
import {
  daemonConfigPath,
  daemonLockPath,
  isDaemonLockStale,
  jobsDir,
  LOG_MAX_BYTES,
  ledgerPath,
  readDaemonLock,
  readJsonOr,
  readTextOrNull,
  rotateDaemonLogs,
  stateDir,
  triggerDir,
  withFileLock,
  writeJson,
} from "./fsx.js";
import { probeHive, triggerUsesHive, type HiveProbe } from "./hive-exec.js";
import { DEFAULT_BINDING_RETENTION } from "./router-gc.js";
import { execArgv } from "./process.js";
import { readBuildCommit, type BuildCommit } from "./build-info.js";
import { parseDuration } from "./time.js";
import { c, sym } from "./ui.js";
import type { DaemonConfig, Job, RouterBinding, ScheduleState, Trigger, TriggerHealth } from "./types.js";

export type DoctorSeverity = "ok" | "warning" | "error";
export type DoctorArea = "daemon" | "hive" | "triggers" | "router" | "state" | "config";
export type DoctorFinding = {
  area: DoctorArea;
  check: string;
  severity: DoctorSeverity;
  message: string;
  fixable?: boolean;
  details?: unknown;
};
export type DoctorFix = { action: string; message: string; details?: unknown };
export type DoctorReport = {
  store: string;
  checkedAt: string;
  status: DoctorSeverity;
  exitCode: 0 | 1 | 2;
  counts: { errors: number; warnings: number };
  findings: DoctorFinding[];
  fixes?: DoctorFix[];
};

const REPEATED_FAILURES = 3;
const HIVE_HEALTH_TIMEOUT_MS = 5_000;
const HIVE_HEALTH_STARTING_EXIT = 75;
const LISTED_IDS = 10;
const LOG_FILES = ["daemon.log", "daemon.out.log", "daemon.err.log"] as const;
const LOCKED_STATE_FILES: ReadonlySet<TriggerStateFile> = new Set(["deliveries-seen.json", "trigger-health.json"]);
const STORE_ENTRIES = new Set([
  "triggers",
  "router-plugins",
  "state",
  "jobs",
  "ledger.jsonl",
  "ledger.jsonl.1",
  "daemon.log",
  "daemon.log.1",
  "daemon.out.log",
  "daemon.err.log",
  "pollinate.toml",
  "pollinated.sock",
  ".DS_Store",
]);
const STATE_ENTRIES = new Set([
  ...TRIGGER_STATE_FILES,
  "deliveries-seen.lock",
  "trigger-health.lock",
  "job-id-index.json",
  "job-id-index.lock",
  "jobs-store.json",
  "daemon-runs.json",
  "daemon.lock",
  "invalid-triggers.json",
  "store.json",
  "trigger-locks",
  "job-locks",
  "router-bindings",
  ".DS_Store",
]);

type LoadedFile = { id: string; path: string; trigger?: Trigger; error?: string };

type DaemonFacts = {
  pid: number | null;
  running: boolean;
  startedAt: string | null;
};

type Context = {
  store: PollinateStore;
  config: DaemonConfig;
  files: LoadedFile[];
  triggers: Trigger[];
  daemon: DaemonFacts;
  findings: DoctorFinding[];
};

export async function runDoctor(store: PollinateStore, options: { fix?: boolean } = {}): Promise<DoctorReport> {
  let fixes: DoctorFix[] | undefined;
  if (options.fix) {
    const before = await inspect(store);
    fixes = await applyFixes(store, before);
  }
  const ctx = await inspect(store);
  return buildReport(store, ctx.findings, fixes);
}

function buildReport(store: PollinateStore, findings: DoctorFinding[], fixes?: DoctorFix[]): DoctorReport {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const status: DoctorSeverity = errors ? "error" : warnings ? "warning" : "ok";
  return {
    store: store.root,
    checkedAt: new Date().toISOString(),
    status,
    exitCode: errors ? 2 : warnings ? 1 : 0,
    counts: { errors, warnings },
    findings: redact(findings) as DoctorFinding[],
    ...(fixes ? { fixes: redact(fixes) as DoctorFix[] } : {}),
  };
}

async function inspect(store: PollinateStore): Promise<Context> {
  const findings: DoctorFinding[] = [];
  let config = DEFAULT_DAEMON_CONFIG;
  let configError: string | undefined;
  try {
    config = await store.daemonConfig();
  } catch (error) {
    configError = errorMessage(error);
  }
  const files = await loadTriggerFilesQuietly(store.root);
  const triggers = files.flatMap((file) => (file.trigger ? [file.trigger] : []));
  const daemon = await daemonFacts(store.root);
  const ctx: Context = { store, config, files, triggers, daemon, findings };
  if (configError) add(ctx, "config", "pollinate.toml", "error", `pollinate.toml does not parse: ${configError}`);
  await checkDaemon(ctx);
  await checkHive(ctx);
  await checkTriggers(ctx);
  await checkRouter(ctx);
  await checkState(ctx);
  await checkConfig(ctx);
  return ctx;
}

function add(ctx: Context, area: DoctorArea, check: string, severity: DoctorSeverity, message: string, extra: { fixable?: boolean; details?: unknown } = {}): void {
  ctx.findings.push({ area, check, severity, message, ...(extra.fixable ? { fixable: true } : {}), ...(extra.details !== undefined ? { details: extra.details } : {}) });
}

async function loadTriggerFilesQuietly(root: string): Promise<LoadedFile[]> {
  const dir = triggerDir(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files: LoadedFile[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".toml")).sort()) {
    const path = join(dir, entry);
    const id = idFromPath(path);
    const text = await readTextOrNull(path);
    if (text === null) continue;
    try {
      files.push({ id, path, trigger: { ...parseTriggerToml(text, id), id } });
    } catch (error) {
      files.push({ id, path, error: errorMessage(error) });
    }
  }
  return files;
}

async function daemonFacts(root: string): Promise<DaemonFacts> {
  const holder = await readDaemonLock(daemonLockPath(root)).catch(() => null);
  if (!holder) return { pid: null, running: false, startedAt: null };
  const running = holder.pid !== null && !isDaemonLockStale(holder);
  return { pid: holder.pid, running, startedAt: holder.startedAt };
}

async function checkDaemon(ctx: Context): Promise<void> {
  const root = ctx.store.root;
  const processes = await daemonProcessesFor(root);
  const { daemon } = ctx;
  if (!daemon.running) {
    const stale = daemon.pid !== null ? ` (stale lock from pid ${daemon.pid})` : "";
    add(ctx, "daemon", "running", "warning", `no daemon is running on this store${stale}`);
  } else {
    add(ctx, "daemon", "running", "ok", `daemon pid ${daemon.pid} running since ${daemon.startedAt ?? "unknown"}`);
    await checkDaemonBuild(ctx, processes.find((proc) => proc.pid === daemon.pid));
  }
  const others = processes.filter((proc) => !daemon.running || proc.pid !== daemon.pid);
  if (others.length > 0) {
    const what = daemon.running ? "more daemon process(es) on this store besides the lock holder" : "daemon process(es) on this store without the store lock";
    add(ctx, "daemon", "twin", "error", `${others.length} ${what}: ${others.map((proc) => `pid ${proc.pid}`).join(", ")}`, {
      details: others.map((proc) => ({ pid: proc.pid, command: proc.command })),
    });
  }
  const runs = await readDaemonRuns(root).catch(() => []);
  const loop = crashLoopStatus(runs, daemon.running ? (daemon.pid ?? undefined) : undefined);
  if (loop.crashLoop) add(ctx, "daemon", "crash-loop", "error", `crash loop: ${loop.uncleanExits} unclean daemon exits in the last hour (last ${loop.lastUncleanAt})`);
  else if (loop.uncleanExits > 0) add(ctx, "daemon", "crash-loop", "warning", `${loop.uncleanExits} unclean daemon exit(s) in the last hour (last ${loop.lastUncleanAt})`);
}

async function checkDaemonBuild(ctx: Context, proc: DaemonProcess | undefined): Promise<void> {
  const started = await lastDaemonStart(ctx.store.root, ctx.daemon.pid);
  const entry = started?.entry ?? (proc ? await entryFromProcess(proc) : null);
  const cli = await readBuildCommit();
  const daemonBuild: BuildCommit | null = started?.commit !== undefined ? { commit: started.commit, dirty: started.dirty ?? null, version: null } : entry ? await readBuildCommit(join(dirname(entry), "build-info.json")) : null;
  const cliCommit = cli?.commit ?? null;
  const daemonCommit = daemonBuild?.commit ?? null;
  const askedByDaemon = ctx.daemon.pid === process.pid;
  if (!daemonCommit || !cliCommit) {
    const other = askedByDaemon ? "build on disk" : "CLI";
    add(ctx, "daemon", "commit", "warning", `cannot compare commits: daemon ${short(daemonCommit)}, ${other} ${short(cliCommit)}`, { details: { daemon: daemonCommit, cli: cliCommit, entry } });
  } else if (daemonCommit !== cliCommit) {
    const message = askedByDaemon
      ? `daemon runs ${short(daemonCommit)}, its build on disk is now ${short(cliCommit)}; restart the daemon to run it`
      : `daemon runs ${short(daemonCommit)}, this CLI is ${short(cliCommit)}; restart the daemon to run the same build`;
    add(ctx, "daemon", "commit", "warning", message, { details: { daemon: daemonCommit, cli: cliCommit, entry } });
  } else {
    add(ctx, "daemon", "commit", "ok", askedByDaemon ? `daemon runs ${short(cliCommit)}, the same as its build on disk` : `daemon and CLI both run ${short(cliCommit)}`);
  }
  if (entry) {
    const checkout = await gitCheckoutOf(entry);
    if (checkout) add(ctx, "daemon", "checkout", "warning", `daemon runs from a git checkout (${checkout}); a build there changes what runs. Install a release (scripts/install-runtime.mjs)`, { details: { entry, checkout } });
  }
}

type DaemonStart = { entry?: string; commit?: string | null; dirty?: boolean | null };

async function lastDaemonStart(root: string, pid: number | null): Promise<DaemonStart | null> {
  if (pid === null) return null;
  for await (const line of linesNewestFirst(ledgerPath(root))) {
    if (!line.includes("pollinate.daemon.started")) continue;
    const event = parseLine(line);
    if (event?.event !== "pollinate.daemon.started") continue;
    if (event.pid !== pid) return null;
    return {
      entry: typeof event.entry === "string" ? event.entry : undefined,
      commit: typeof event.commit === "string" || event.commit === null ? (event.commit as string | null) : undefined,
      dirty: typeof event.dirty === "boolean" ? event.dirty : null,
    };
  }
  return null;
}

async function gitCheckoutOf(entry: string): Promise<string | null> {
  let dir = dirname(entry);
  for (let depth = 0; depth < 4; depth += 1) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

type DaemonProcess = { pid: number; command: string };

async function daemonProcessesFor(root: string): Promise<DaemonProcess[]> {
  const listing = await execArgv("ps", ["-axww", "-o", "pid=,command="], { timeoutMs: 5_000 }).catch(() => null);
  if (!listing || listing.exitCode !== 0) return [];
  const wanted = resolve(root);
  const found: DaemonProcess[] = [];
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const proc = { pid: Number(match[1]), command: match[2] ?? "" };
    if (proc.pid === process.pid || !isDaemonCommand(proc.command)) continue;
    const entry = await entryFromProcess(proc);
    if (!entry || !(await isPollinateEntry(entry))) continue;
    const storeRoot = await storeRootOfProcess(proc.pid);
    if (storeRoot !== null && resolve(storeRoot) === wanted) found.push(proc);
  }
  return found;
}

async function isPollinateEntry(entry: string): Promise<boolean> {
  let dir = dirname(entry);
  for (let depth = 0; depth < 3; depth += 1) {
    const pkg = await readJsonOr<{ name?: unknown } | null>(join(dir, "package.json"), null);
    if (pkg) return pkg.name === "pollinate";
    dir = dirname(dir);
  }
  return false;
}

function isDaemonCommand(command: string): boolean {
  if (/^\S*\b(sh|bash|zsh|dash)\s+-c\b/.test(command)) return false;
  return /(cli\.js|\/pol|\/pollinate|^pol|^pollinate)\s+daemon\s+run\b/.test(command);
}

async function storeRootOfProcess(pid: number): Promise<string | null> {
  const env = await processEnvironment(pid);
  if (env === null) return null;
  return env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate");
}

async function processEnvironment(pid: number): Promise<Record<string, string> | null> {
  if (process.platform === "linux") {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => null);
    if (raw === null) return null;
    return Object.fromEntries(raw.split("\0").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  }
  const result = await execArgv("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const env: Record<string, string> = {};
  for (const match of result.stdout.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)) env[match[1] as string] = match[2] ?? "";
  return env;
}

async function entryFromProcess(proc: DaemonProcess): Promise<string | null> {
  const token = proc.command.split(/\s+/).find((part) => part.endsWith("cli.js") || /(^|\/)(pol|pollinate)$/.test(part));
  if (!token) return null;
  const base = token.startsWith("/") ? "" : await processCwd(proc.pid);
  if (base === null) return null;
  const path = token.startsWith("/") ? token : token.includes("/") ? resolve(base, token) : await whichOnPath(token);
  return path ? realpath(path).catch(() => null) : null;
}

async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") return realpath(`/proc/${pid}/cwd`).catch(() => null);
  const result = await execArgv("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 5_000 }).catch(() => null);
  const line = result?.stdout.split("\n").find((item) => item.startsWith("n"));
  return line ? line.slice(1) : null;
}

async function whichOnPath(command: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await isExecutable(join(dir, command))) return join(dir, command);
  }
  return null;
}

async function checkHive(ctx: Context): Promise<void> {
  const users = ctx.triggers.filter(triggerUsesHive).map((trigger) => trigger.id);
  const bin = ctx.config.honeybee.bin;
  const probe = await probeHive(bin, ctx.config.execution);
  const needed = users.length > 0;
  if (!probe.ok) {
    if (!probe.path && !needed) {
      add(ctx, "hive", "binary", "ok", "hive not found, and no enabled trigger uses it");
      return;
    }
    add(ctx, "hive", "binary", needed ? "error" : "warning", `hive ${probe.path ?? bin ?? "hive"} fails: ${probe.error ?? "unknown error"}${needed ? ` (${users.length} trigger(s) use hive)` : ""}`, { details: { ...probe, users: users.slice(0, LISTED_IDS) } });
  } else {
    add(ctx, "hive", "binary", "ok", `hive ${probe.path} version ${probe.version}${bin ? " ([honeybee] bin)" : " (execution PATH)"}`);
    await checkHiveHealth(ctx, probe, needed);
  }
  await checkStaleHives(ctx, probe);
}

async function checkHiveHealth(ctx: Context, probe: HiveProbe, needed: boolean): Promise<void> {
  if (!probe.path) return;
  const result = await execArgv(probe.path, ["health", "--json"], { timeoutMs: HIVE_HEALTH_TIMEOUT_MS, execution: ctx.config.execution }).catch((error: unknown) => ({
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: errorMessage(error),
    timedOut: false,
  }));
  if (result.exitCode === 0) {
    add(ctx, "hive", "health", "ok", "hive health ok");
    return;
  }
  const reason = result.timedOut ? `timed out after ${HIVE_HEALTH_TIMEOUT_MS}ms` : result.exitCode === HIVE_HEALTH_STARTING_EXIT ? "Honeybee is starting" : firstLine(result.stderr) || firstLine(result.stdout) || `exited ${result.exitCode}`;
  const severity: DoctorSeverity = result.exitCode === HIVE_HEALTH_STARTING_EXIT || !needed ? "warning" : "error";
  add(ctx, "hive", "health", severity, `hive health: ${reason}`);
}

async function checkStaleHives(ctx: Context, probe: HiveProbe): Promise<void> {
  const configured = probe.path ? await realpath(probe.path).catch(() => probe.path) : null;
  const copies: Array<{ path: string; real: string }> = [];
  for (const dir of executionPathDirs(ctx.config)) {
    const candidate = join(dir, "hive");
    if (!(await isExecutable(candidate))) continue;
    const real = await realpath(candidate).catch(() => candidate);
    if (real === configured) break;
    if (!copies.some((copy) => copy.real === real)) copies.push({ path: candidate, real });
  }
  const stale: Array<{ path: string; version: string | null; error?: string }> = [];
  for (const copy of copies) {
    const other = await probeHive(copy.path, ctx.config.execution);
    if (!other.ok || !probe.ok || other.version !== probe.version) stale.push({ path: copy.path, version: other.version, ...(other.error ? { error: other.error } : {}) });
  }
  if (stale.length === 0) {
    add(ctx, "hive", "stale-copies", "ok", "no other hive earlier on the execution PATH");
    return;
  }
  const describe = stale.map((copy) => `${copy.path} (${copy.version ?? copy.error ?? "no version"})`).join(", ");
  add(ctx, "hive", "stale-copies", "error", `stale hive earlier on the execution PATH than ${probe.path ?? "the configured one"} (${probe.version ?? "unknown"}): ${describe}; a bare \`hive\` in commands and bees runs it`, {
    details: { configured: probe.path, configuredVersion: probe.version, stale },
  });
}

function executionPathDirs(config: DaemonConfig): string[] {
  const execution = config.execution;
  const path = execution.env.PATH ?? (execution.inheritEnv ? (process.env.PATH ?? "") : "");
  return path.split(delimiter).filter(Boolean);
}

async function checkTriggers(ctx: Context): Promise<void> {
  const invalid = ctx.files.filter((file) => file.error);
  const removed = invalid.filter((file) => /was removed from Pollinate/.test(file.error ?? ""));
  const broken = invalid.filter((file) => !removed.includes(file));
  if (broken.length) {
    add(ctx, "triggers", "invalid", "error", `${broken.length} trigger file(s) do not load: ${listIds(broken.map((file) => file.id))}`, {
      details: broken.map((file) => ({ id: file.id, path: file.path, error: file.error })),
    });
  }
  if (removed.length) {
    add(ctx, "triggers", "removed-kinds", "error", `${removed.length} trigger file(s) use a removed action kind: ${listIds(removed.map((file) => file.id))}`, {
      details: removed.map((file) => ({ id: file.id, path: file.path, error: file.error })),
    });
  }
  if (!invalid.length) add(ctx, "triggers", "invalid", "ok", `${ctx.files.length} trigger file(s) load`);

  const health = await readJsonOr<TriggerHealth>(join(stateDir(ctx.store.root), "trigger-health.json"), {});
  const ids = new Set(ctx.files.map((file) => file.id));
  const failing = Object.entries(health)
    .filter(([id, entry]) => ids.has(id) && (entry.consecutiveFailures ?? 0) >= REPEATED_FAILURES)
    .map(([id, entry]) => ({ id, consecutiveFailures: entry.consecutiveFailures, kind: entry.lastFailureKind, since: entry.firstFailedAt, lastError: entry.lastError }));
  if (failing.length) {
    add(ctx, "triggers", "failing", "error", `${failing.length} trigger(s) failing repeatedly: ${failing.map((entry) => `${entry.id} (${entry.consecutiveFailures}x ${entry.kind})`).slice(0, LISTED_IDS).join(", ")}`, { details: failing });
  }

  const schedule = await readJsonOr<ScheduleState>(join(stateDir(ctx.store.root), "schedule-state.json"), {});
  const spent = ctx.triggers.map((trigger) => ({ id: trigger.id, reason: spentReason(trigger, schedule) })).filter((entry) => entry.reason);
  if (spent.length) {
    add(ctx, "triggers", "spent", "warning", `${spent.length} trigger(s) will never fire again but are still present: ${listIds(spent.map((entry) => entry.id))}; remove them with pol remove <id>`, { details: spent });
  } else {
    add(ctx, "triggers", "spent", "ok", "no spent triggers");
  }
}

function spentReason(trigger: Trigger, schedule: ScheduleState, now = Date.now()): string | undefined {
  const lifecycle = trigger.lifecycle;
  if (lifecycle?.maxDeliveries !== undefined && (lifecycle.deliveries ?? 0) >= lifecycle.maxDeliveries) return "max_deliveries";
  if (lifecycle?.expiresAt && Date.parse(lifecycle.expiresAt) <= now) return "expired";
  if (trigger.source.kind === "schedule" && trigger.source.timing.type === "once") {
    if (schedule[trigger.id]?.completedOnce) return "once-fired";
    if (!trigger.enabled && Date.parse(trigger.source.timing.at) <= now) return "once-past";
  }
  return undefined;
}

async function checkRouter(ctx: Context): Promise<void> {
  const bindings = await ctx.store.listRouterBindings();
  const ids = new Set(ctx.files.map((file) => file.id));
  const retentionMs = parseDuration(ctx.config.router?.bindingRetention ?? DEFAULT_BINDING_RETENTION);
  const now = Date.now();
  const perTrigger = new Map<string, { errored: string[]; closing: string[]; expired: string[]; orphan: string[] }>();
  for (const binding of bindings) {
    const bucket = perTrigger.get(binding.triggerId) ?? { errored: [], closing: [], expired: [], orphan: [] };
    perTrigger.set(binding.triggerId, bucket);
    if (binding.status === "errored") bucket.errored.push(binding.subjectKey);
    if (binding.status === "closing") bucket.closing.push(binding.subjectKey);
    if (binding.status === "closed" && now - Date.parse(binding.updatedAt) >= retentionMs) bucket.expired.push(binding.subjectKey);
    if (!ids.has(binding.triggerId) && (binding.status === "active" || binding.status === "pending")) bucket.orphan.push(binding.subjectKey);
  }
  let reported = false;
  for (const [triggerId, bucket] of perTrigger) {
    const gone = ids.has(triggerId) ? "" : " (trigger removed; the GC never visits them)";
    if (bucket.errored.length) {
      reported = true;
      add(ctx, "router", "errored", "warning", `${triggerId}: ${bucket.errored.length} errored binding(s)${gone}`, { details: { triggerId, subjects: bucket.errored } });
    }
    if (bucket.closing.length) {
      reported = true;
      add(ctx, "router", "closing", "warning", `${triggerId}: ${bucket.closing.length} binding(s) stuck closing${gone}`, { details: { triggerId, subjects: bucket.closing } });
    }
    if (bucket.expired.length) {
      reported = true;
      add(ctx, "router", "closed-expired", "warning", `${triggerId}: ${bucket.expired.length} closed binding(s) past bindingRetention ${ctx.config.router?.bindingRetention ?? DEFAULT_BINDING_RETENTION}`, {
        fixable: true,
        details: { triggerId, subjects: bucket.expired },
      });
    }
    if (bucket.orphan.length) {
      reported = true;
      add(ctx, "router", "orphan", "warning", `${triggerId}: ${bucket.orphan.length} open binding(s) of a trigger that no longer exists; the GC never visits them`, { details: { triggerId, subjects: bucket.orphan } });
    }
  }
  if (!reported) add(ctx, "router", "bindings", "ok", `${bindings.length} binding(s), none errored, closing or expired`);
}

async function checkState(ctx: Context): Promise<void> {
  const root = ctx.store.root;
  const orphans = await orphanStateEntries(root, new Set(ctx.files.map((file) => file.id)));
  const total = Object.values(orphans).reduce((sum, keys) => sum + keys.length, 0);
  if (total > 0) {
    add(ctx, "state", "orphans", "warning", `state entries for triggers that no longer exist: ${total}`, {
      fixable: true,
      details: Object.fromEntries(Object.entries(orphans).map(([file, keys]) => [file, { count: keys.length, ids: keys.slice(0, LISTED_IDS) }])),
    });
  } else {
    add(ctx, "state", "orphans", "ok", "no orphan state entries");
  }

  const census = await ctx.store.censusJobs();
  const retention = ctx.config.retention;
  const jobsMb = census.bytes / 1_048_576;
  const jobsSeverity: DoctorSeverity = census.files >= retention.jobsWarnFiles || jobsMb >= retention.jobsWarnMb ? "warning" : "ok";
  add(ctx, "state", "jobs-size", jobsSeverity, `jobs: ${census.files} file(s), ${formatBytes(census.bytes)}${jobsSeverity === "ok" ? "" : ` (warn at ${retention.jobsWarnFiles} files or ${retention.jobsWarnMb} MB)`}`, {
    details: { files: census.files, bytes: census.bytes },
  });

  const ledgerSize = await sizeOf(ledgerPath(root));
  const ledgerOldSize = await sizeOf(`${ledgerPath(root)}.1`);
  const ledgerLimit = retention.ledgerMaxMb * 1_048_576;
  const ledgerSeverity: DoctorSeverity = ledgerSize > 2 * ledgerLimit ? "warning" : "ok";
  add(ctx, "state", "ledger-size", ledgerSeverity, `ledger: ${formatBytes(ledgerSize)} (+ ${formatBytes(ledgerOldSize)} rotated), rotates past ${retention.ledgerMaxMb} MB`, {
    details: { bytes: ledgerSize, rotatedBytes: ledgerOldSize },
  });

  for (const name of LOG_FILES) {
    const size = await sizeOf(join(root, name));
    if (size > LOG_MAX_BYTES) {
      add(ctx, "state", "log-size", "warning", `${name} is ${formatBytes(size)} (over ${formatBytes(LOG_MAX_BYTES)})`, { fixable: true, details: { file: name, bytes: size } });
    }
  }

  const foreign = await foreignFiles(root);
  if (foreign.length) add(ctx, "state", "foreign-files", "warning", `${foreign.length} file(s) in the store that Pollinate does not own: ${foreign.slice(0, LISTED_IDS).join(", ")}`, { details: foreign });
}

async function orphanStateEntries(root: string, ids: Set<string>): Promise<Partial<Record<TriggerStateFile, string[]>>> {
  const result: Partial<Record<TriggerStateFile, string[]>> = {};
  for (const file of TRIGGER_STATE_FILES) {
    const state = await readJsonOr<Record<string, unknown> | null>(join(stateDir(root), file), null);
    if (!state || typeof state !== "object" || Array.isArray(state)) continue;
    const orphans = Object.keys(state).filter((key) => !ids.has(key));
    if (orphans.length) result[file] = orphans;
  }
  return result;
}

async function foreignFiles(root: string): Promise<string[]> {
  const foreign: string[] = [];
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (!STORE_ENTRIES.has(entry)) foreign.push(entry);
  }
  for (const entry of await readdir(stateDir(root)).catch(() => [] as string[])) {
    if (STATE_ENTRIES.has(entry) || /^\..*\.tmp$/.test(entry)) continue;
    foreign.push(join("state", entry));
  }
  for (const entry of await readdir(triggerDir(root)).catch(() => [] as string[])) {
    if (!entry.endsWith(".toml") && !/^\..*\.tmp$/.test(entry)) foreign.push(join("triggers", entry));
  }
  for (const entry of await readdir(jobsDir(root)).catch(() => [] as string[])) {
    if (!entry.endsWith(".json") && !/^\..*\.tmp$/.test(entry)) foreign.push(join("jobs", entry));
  }
  return foreign;
}

async function checkConfig(ctx: Context): Promise<void> {
  const pathEntries = ctx.config.execution.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  const missing: string[] = [];
  for (const entry of pathEntries) if (!(await exists(entry))) missing.push(entry);
  if (missing.length) add(ctx, "config", "path", "warning", `[execution.env].PATH entries that do not exist (${missing.length}): ${missing.join(", ")}`, { details: missing });
  else add(ctx, "config", "path", "ok", pathEntries.length ? "every [execution.env].PATH entry exists" : "[execution.env].PATH not set");

  if (!ctx.daemon.running || !ctx.daemon.startedAt) return;
  const info = await stat(daemonConfigPath(ctx.store.root)).catch(() => null);
  if (info && info.mtimeMs > Date.parse(ctx.daemon.startedAt)) {
    add(ctx, "config", "changed", "warning", `pollinate.toml changed at ${info.mtime.toISOString()}, after the daemon started (${ctx.daemon.startedAt}); restart the daemon to apply it`);
  }
}

async function applyFixes(store: PollinateStore, ctx: Context): Promise<DoctorFix[]> {
  const fixes: DoctorFix[] = [];
  const pruned = await pruneOrphanState(store, ctx);
  if (pruned) fixes.push(pruned);
  const bindings = await pruneExpiredBindings(store, ctx);
  if (bindings) fixes.push(bindings);
  for (const rotated of await rotateLogs(store.root)) fixes.push(rotated);
  if (fixes.length) {
    await store.appendLedger({ event: "pollinate.doctor.fixed", fixes: fixes.map((fix) => ({ action: fix.action, message: fix.message })) });
  }
  return fixes;
}

async function pruneOrphanState(store: PollinateStore, ctx: Context): Promise<DoctorFix | undefined> {
  const ids = new Set(ctx.files.map((file) => file.id));
  const files: Partial<Record<TriggerStateFile, { before: number; after: number }>> = {};
  const skipped: TriggerStateFile[] = [];
  let entries = 0;
  for (const file of TRIGGER_STATE_FILES) {
    const path = join(stateDir(store.root), file);
    const locked = LOCKED_STATE_FILES.has(file);
    const prune = async () => {
      const state = await readJsonOr<Record<string, unknown> | null>(path, null);
      if (!state || typeof state !== "object" || Array.isArray(state)) return;
      const keys = Object.keys(state);
      const dropped = keys.filter((key) => !ids.has(key));
      if (dropped.length === 0) return;
      if (ctx.daemon.running && !locked) {
        skipped.push(file);
        return;
      }
      for (const key of dropped) delete state[key];
      await writeJson(path, state);
      files[file] = { before: keys.length, after: keys.length - dropped.length };
      entries += dropped.length;
    };
    if (file === "deliveries-seen.json") await withFileLock(store.deliveriesSeenLockPath(), prune);
    else if (file === "trigger-health.json") await withFileLock(store.triggerHealthLockPath(), prune);
    else await prune();
  }
  if (entries > 0) await store.appendLedger({ event: "pollinate.state.pruned", reason: "doctor", entries, files });
  if (entries === 0 && skipped.length === 0) return undefined;
  const skippedNote = skipped.length ? `; left ${skipped.join(", ")} to the daemon, which prunes them at its next start` : "";
  return { action: "prune-orphan-state", message: `pruned ${entries} orphan state entr${entries === 1 ? "y" : "ies"}${skippedNote}`, details: { entries, files, skipped } };
}

async function pruneExpiredBindings(store: PollinateStore, ctx: Context): Promise<DoctorFix | undefined> {
  const retention = ctx.config.router?.bindingRetention ?? DEFAULT_BINDING_RETENTION;
  const retentionMs = parseDuration(retention);
  const deleted: Array<{ triggerId: string; subjectKey: string }> = [];
  for (const binding of await store.listRouterBindings()) {
    if (binding.status !== "closed" || Date.now() - Date.parse(binding.updatedAt) < retentionMs) continue;
    const removed = await store.withRouterBindingLock(binding.triggerId, binding.subjectKey, async () => {
      const current = await store.getRouterBinding(binding.triggerId, binding.subjectKey);
      if (!current || !isExpiredClosed(current, retentionMs)) return false;
      await store.deleteRouterBinding(binding.triggerId, binding.subjectKey);
      return true;
    });
    if (!removed) continue;
    deleted.push({ triggerId: binding.triggerId, subjectKey: binding.subjectKey });
    await store.appendLedger({
      event: "pollinate.router.binding_pruned",
      trigger_id: binding.triggerId,
      router: binding.router,
      subject_key: binding.subjectKey,
      closed_at: binding.updatedAt,
      reason: "doctor",
    });
  }
  if (!deleted.length) return undefined;
  return { action: "prune-closed-bindings", message: `deleted ${deleted.length} closed binding(s) past bindingRetention ${retention}`, details: deleted };
}

function isExpiredClosed(binding: RouterBinding, retentionMs: number): boolean {
  return binding.status === "closed" && Date.now() - Date.parse(binding.updatedAt) >= retentionMs;
}

export async function rotateLogs(root: string): Promise<DoctorFix[]> {
  return (await rotateDaemonLogs(root)).map((rotation) => ({
    action: "rotate-log",
    message:
      rotation.keptBytes === undefined
        ? `rotated ${rotation.file} (${formatBytes(rotation.bytes)}) to ${rotation.file}.1`
        : `cut ${rotation.file} from ${formatBytes(rotation.bytes)} to its last ${formatBytes(rotation.keptBytes)}`,
    details: rotation,
  }));
}

export type WhyOutcome = "fired" | "filtered" | "throttled" | "duplicate" | "dropped" | "errored";
export type WhyActivation = {
  at: string;
  outcome: WhyOutcome;
  event: string;
  jobId?: string;
  deliveryId?: string;
  status?: string;
  detail?: string;
};
export type WhyReport = { triggerId: string; exists: boolean; activations: WhyActivation[]; scannedFiles: string[] };

const DIRECT_OUTCOMES: Record<string, WhyOutcome> = {
  "pollinate.delivery.filtered": "filtered",
  "pollinate.router.open_filtered": "filtered",
  "pollinate.delivery.throttled": "throttled",
  "pollinate.delivery.duplicate": "duplicate",
  "pollinate.webhook.duplicate": "duplicate",
  "pollinate.delivery.dropped": "dropped",
  "pollinate.router.open_rate_limited": "dropped",
  "pollinate.webhook.rejected": "dropped",
  "pollinate.schedule.errored": "errored",
  "pollinate.poll.errored": "errored",
};

type JobEnd = { outcome: WhyOutcome; status: string; detail?: string };

export async function explainTrigger(store: PollinateStore, triggerId: string, limit = 20): Promise<WhyReport> {
  const triggerExists = (await readTextOrNull(store.triggerPath(triggerId))) !== null;
  const needle = `"trigger_id":${JSON.stringify(triggerId)}`;
  const activations: WhyActivation[] = [];
  const jobEnds = new Map<string, JobEnd>();
  const jobDeliveries = new Map<string, string>();
  const scannedFiles: string[] = [];
  for (const path of [ledgerPath(store.root), `${ledgerPath(store.root)}.1`]) {
    if (activations.length >= limit) break;
    if (!(await exists(path))) continue;
    scannedFiles.push(path);
    for await (const line of linesNewestFirst(path)) {
      if (!line.includes(needle)) continue;
      const event = parseLine(line);
      if (!event || event.trigger_id !== triggerId || typeof event.event !== "string") continue;
      const activation = activationOf(event, jobEnds, jobDeliveries);
      if (!activation) continue;
      activations.push(activation);
      if (activations.length >= limit) break;
    }
  }
  for (const activation of activations) await enrichFromJobFile(store, activation);
  return { triggerId, exists: triggerExists, activations: redact(activations) as WhyActivation[], scannedFiles };
}

async function enrichFromJobFile(store: PollinateStore, activation: WhyActivation): Promise<void> {
  if (!activation.jobId) return;
  const job = await readJsonOr<Job | null>(store.jobPath(activation.jobId), null);
  if (!job) return;
  activation.deliveryId ??= job.deliveryId;
  if (activation.status !== "pending") return;
  activation.status = job.status;
  if (job.status === "errored" || job.status === "timed-out") {
    activation.outcome = "errored";
    if (job.error) activation.detail = job.error;
  }
  if (job.status === "cancelled") activation.outcome = "dropped";
}

function activationOf(event: Record<string, unknown>, jobEnds: Map<string, JobEnd>, jobDeliveries: Map<string, string>): WhyActivation | undefined {
  const name = event.event as string;
  const at = typeof event.ts === "string" ? event.ts : "";
  const jobId = typeof event.job_id === "string" ? event.job_id : undefined;
  const deliveryId = typeof event.delivery_id === "string" ? event.delivery_id : undefined;
  if (jobId && deliveryId && !jobDeliveries.has(jobId)) jobDeliveries.set(jobId, deliveryId);
  if (jobId && !jobEnds.has(jobId)) {
    if (name === "pollinate.job.completed") jobEnds.set(jobId, { outcome: "fired", status: "completed" });
    if (name === "pollinate.job.errored") jobEnds.set(jobId, { outcome: "errored", status: "errored", detail: stringOf(event.error) });
    if (name === "pollinate.job.cancelled") jobEnds.set(jobId, { outcome: "dropped", status: "cancelled", detail: stringOf(event.reason) ?? "cancelled" });
  }
  if (name === "pollinate.job.queued") {
    if (event.source === "failure" || !jobId) return undefined;
    const end = jobEnds.get(jobId) ?? { outcome: "fired" as const, status: "pending" };
    return { at, outcome: end.outcome, event: name, jobId, deliveryId: jobDeliveries.get(jobId), status: end.status, ...(end.detail ? { detail: end.detail } : {}) };
  }
  const outcome = DIRECT_OUTCOMES[name];
  if (!outcome) return undefined;
  const detail = directDetail(name, event);
  return { at, outcome, event: name, ...(deliveryId ? { deliveryId } : {}), ...(detail ? { detail } : {}) };
}

function directDetail(name: string, event: Record<string, unknown>): string | undefined {
  if (name === "pollinate.delivery.throttled") return event.until ? `until ${String(event.until)}` : undefined;
  if (name === "pollinate.webhook.rejected") return `webhook rejected: ${stringOf(event.reason) ?? "unknown"}`;
  if (name === "pollinate.router.open_filtered") return `openWhen did not match ${stringOf(event.subject_key) ?? ""}`.trim();
  if (name === "pollinate.router.open_rate_limited") return stringOf(event.reason);
  return stringOf(event.error) ?? stringOf(event.reason);
}

async function* linesNewestFirst(path: string, chunkSize = 256 * 1024): AsyncGenerator<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return;
  try {
    let position = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const chunk = Buffer.alloc(position - start);
      await handle.read(chunk, 0, chunk.length, start);
      position = start;
      let buffer = Buffer.concat([chunk, carry]);
      let end = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        const line = buffer.subarray(index + 1, end).toString("utf8").trim();
        if (line) yield line;
        end = index;
      }
      carry = Buffer.from(buffer.subarray(0, end));
      buffer = Buffer.alloc(0);
    }
    const first = carry.toString("utf8").trim();
    if (first) yield first;
  } finally {
    await handle.close();
  }
}

const SECRET_KEY = /secret|token|password|passwd|authorization|cookie|api[-_]?key|signature|credential|private[-_]?key/i;
const SECRET_TEXT: RegExp[] = [
  /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|x-hub-signature(?:-256)?|x-pollinate-signature|x-signature|x-vercel-signature|secret|token|password)\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer|basic|token)\s+\S+|\S+)/gi,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
];

export function redact(value: unknown, key = ""): unknown {
  if (key && SECRET_KEY.test(key) && value !== null && typeof value !== "object") return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    if (/^headers$/i.test(key)) return Object.fromEntries(Object.keys(value).map((name) => [name, "[redacted]"]));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}

function redactText(text: string): string {
  let out = text;
  out = out.replace(SECRET_TEXT[1] as RegExp, (_match, prefix: string) => `${prefix}[redacted]`);
  out = out.replace(SECRET_TEXT[0] as RegExp, (_match, scheme: string) => `${scheme} [redacted]`);
  out = out.replace(SECRET_TEXT[2] as RegExp, "[redacted]");
  return out;
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [`pol doctor ${c.dim(report.store)}`, ""];
  const areas: DoctorArea[] = ["daemon", "hive", "triggers", "router", "state", "config"];
  for (const area of areas) {
    const findings = report.findings.filter((finding) => finding.area === area);
    if (!findings.length) continue;
    lines.push(c.bold(area));
    for (const finding of findings) {
      const mark = finding.severity === "error" ? c.red(sym.cross) : finding.severity === "warning" ? c.yellow(sym.warn) : c.green(sym.check);
      lines.push(`  ${mark} ${finding.message}${finding.fixable ? c.dim(" (--fix)") : ""}`);
    }
  }
  if (report.fixes) {
    lines.push("", c.bold("fixed"));
    if (!report.fixes.length) lines.push(`  ${c.dim("nothing to fix")}`);
    for (const fix of report.fixes) lines.push(`  ${c.green(sym.check)} ${fix.message}`);
  }
  const summary = `${report.counts.errors} error(s), ${report.counts.warnings} warning(s)`;
  const color = report.status === "error" ? c.red : report.status === "warning" ? c.yellow : c.green;
  lines.push("", `${color(summary)} ${c.dim(`exit ${report.exitCode}`)}`);
  return lines.join("\n");
}

export function renderWhy(report: WhyReport): string {
  const lines: string[] = [`pol why ${report.triggerId}${report.exists ? "" : c.yellow(" (no trigger file; showing ledger history)")}`];
  if (!report.activations.length) {
    lines.push(c.dim("  no activations in the ledger"));
    return lines.join("\n");
  }
  for (const activation of report.activations) {
    const color = activation.outcome === "fired" ? c.green : activation.outcome === "errored" ? c.red : c.yellow;
    const parts = [
      c.dim(activation.at),
      color(activation.outcome.padEnd(9)),
      activation.jobId ? `job ${activation.jobId}${activation.status && activation.status !== "completed" && activation.status !== activation.outcome ? ` (${activation.status})` : ""}` : c.dim(activation.event.replace(/^pollinate\./, "")),
      activation.deliveryId ? c.dim(activation.deliveryId) : "",
      activation.detail ? truncateText(activation.detail.replace(/:\s*$/, ""), 160) : "",
    ].filter(Boolean);
    lines.push(`  ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function listIds(ids: string[]): string {
  const shown = ids.slice(0, LISTED_IDS).join(", ");
  return ids.length > LISTED_IDS ? `${shown}, … (+${ids.length - LISTED_IDS})` : shown;
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 12) : "unknown";
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.size ?? 0;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
