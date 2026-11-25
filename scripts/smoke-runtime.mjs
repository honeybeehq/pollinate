#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const TERMINAL = new Set(["completed", "errored", "timed-out", "cancelled"]);
const STEP_BOUND_MS = 30_000;

const [tarball, sha] = process.argv.slice(2);
if (!tarball || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("usage: node scripts/smoke-runtime.mjs <pollinate-<sha>-standalone.tgz> <40-hex sha>");
  process.exit(2);
}

const say = (message) => console.log(`smoke: ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, probe, isAlive = () => true) {
  const deadline = Date.now() + STEP_BOUND_MS;
  let last;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error(`daemon exited while waiting for ${what}`);
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${STEP_BOUND_MS / 1000}s waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function checkTree(root, dir = root) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target)) throw new Error(`absolute symlink ${relative(root, path)} -> ${target}`);
      if (relative(root, resolve(dirname(path), target)).startsWith("..")) throw new Error(`symlink ${relative(root, path)} -> ${target} leaves the runtime`);
    } else if (stat.isDirectory()) {
      checkTree(root, path);
    }
  }
}

const top = `pollinate-${sha}`;
const work = mkdtempSync(join(tmpdir(), "pollinate-smoke-"));
const entries = execFileSync("tar", ["-tzf", resolve(tarball)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
const stray = entries.find((entry) => !(entry === `${top}/` || entry.startsWith(`${top}/`)) || entry.split("/").includes(".."));
if (stray !== undefined) throw new Error(`standalone tarball has an entry outside ${top}/: ${stray}`);
execFileSync("tar", ["-xzf", resolve(tarball), "-C", work, "--no-same-owner"]);
const runtime = join(work, top);
checkTree(runtime);
const cli = join(runtime, "dist", "cli.js");
if (!existsSync(cli)) throw new Error(`${top}/dist/cli.js is missing`);
say(`unpacked ${entries.length} entries into ${runtime}`);

const store = join(work, "store");
const marker = join(work, "marker");
mkdirSync(store);
if (!/^[\w/.-]+$/.test(marker)) throw new Error(`temp path ${marker} is not shell-safe`);

const env = {
  PATH: "/usr/bin:/bin",
  HOME: work,
  TMPDIR: tmpdir(),
  POLLINATE_STORE_ROOT: store,
  NO_COLOR: "1",
  npm_config_offline: "true",
};

const pol = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: work, env, encoding: "utf8" });

const version = JSON.parse(pol("--version", "--json"));
if (version.commit !== sha) throw new Error(`--version --json reports commit ${version.commit}, expected ${sha}`);
say(`--version --json: ${JSON.stringify(version)}`);

const port = await freePort();
writeFileSync(join(store, "pollinate.toml"), `[webhook]\nbind = "127.0.0.1"\nport = ${port}\n`);
const triggerFile = join(work, "smoke.toml");
writeFileSync(
  triggerFile,
  [
    "[trigger]",
    'id = "smoke"',
    "[trigger.source]",
    'kind = "webhook"',
    "[trigger.source.webhook]",
    'path = "smoke"',
    "[trigger.action]",
    'kind = "command"',
    `command = "echo fired > '${marker}'"`,
    "",
  ].join("\n"),
);
pol("add", triggerFile);
say(`added trigger smoke (webhook /hook/smoke on 127.0.0.1:${port})`);

const daemonLog = join(work, "daemon.log");
const logFd = openSync(daemonLog, "a");
const daemon = spawn(process.execPath, [cli, "daemon", "run", "--foreground"], { cwd: work, env, stdio: ["ignore", logFd, logFd] });
let exited = false;
daemon.on("exit", () => {
  exited = true;
});
say(`daemon started, pid ${daemon.pid}`);

async function stopDaemon() {
  if (exited) return;
  process.kill(daemon.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (!exited && Date.now() < deadline) await sleep(100);
  if (!exited) {
    process.kill(daemon.pid, "SIGKILL");
    throw new Error(`daemon pid ${daemon.pid} ignored SIGTERM for 10s`);
  }
  say(`daemon pid ${daemon.pid} stopped`);
}

try {
  const accepted = await until(
    "the webhook to accept a delivery",
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/smoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ smoke: sha }),
      });
      return response.ok ? `${response.status} ${await response.text()}` : undefined;
    },
    () => !exited,
  );
  say(`fired: POST /hook/smoke -> ${accepted.trim()}`);
  const job = await until(
    "a terminal smoke job",
    () => JSON.parse(pol("jobs", "--trigger", "smoke", "--json")).find((item) => TERMINAL.has(item.status)),
    () => !exited,
  );
  if (job.status !== "completed") throw new Error(`job ${job.id} ended ${job.status}: ${JSON.stringify(job)}`);
  if (readFileSync(marker, "utf8").trim() !== "fired") throw new Error("the command action did not write the marker");
  say(`job ${job.id} ${job.status}; marker written`);
  await stopDaemon();
  say("PASS");
} catch (error) {
  await stopDaemon().catch(() => {});
  console.error(`smoke: FAIL: ${error.message}`);
  console.error(`--- daemon log (${daemonLog}) ---\n${existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : ""}`);
  process.exitCode = 1;
}
