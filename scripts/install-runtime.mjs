#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = "honeybeehq/pollinate";
const LABEL = "dev.pollinate.pollinated";
const BIN_NAMES = ["pol", "pollinate"];
const FULL_SHA = /^[0-9a-f]{40}$/;
const PLIST_KEYS = ["Label", "ProgramArguments", "EnvironmentVariables", "RunAtLoad", "KeepAlive", "StandardOutPath", "StandardErrorPath"];

const USAGE = `usage: node scripts/install-runtime.mjs [<40-hex sha> | latest] [--root <dir>] [--launchd] [--bin <dir>]

  <sha> | latest  release runtime-<sha> to install; latest is the newest runtime-* release with a standalone asset
  --root <dir>    install root (default ~/.local/share/pollinate): unpacks to <root>/<sha>, points <root>/current at it
  --launchd       rewrite ~/Library/LaunchAgents/${LABEL}.plist to run <root>/current/dist/cli.js,
                  keeping its node, environment and log paths; the old plist is copied to <root>/rollback/.
                  Nothing is restarted: run "pol daemon restart" afterwards
  --bin <dir>     point <dir>/pol and <dir>/pollinate at <root>/current/dist/cli.js; the old targets are
                  written to <root>/rollback/ as a restore script

Set GITHUB_TOKEN, or log in with gh, to raise the GitHub API rate limit.`;

class UsageError extends Error {}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const say = (message) => console.log(`install-runtime: ${message}`);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const xmlText = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const standaloneName = (sha) => `pollinate-${sha}-standalone.tgz`;

function parseCommandLine() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        root: { type: "string" },
        launchd: { type: "boolean" },
        bin: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${USAGE}`);
  }
  if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (parsed.positionals.length > 1) throw new UsageError(USAGE);
  const target = parsed.positionals[0] ?? "latest";
  if (target !== "latest" && !FULL_SHA.test(target)) {
    throw new UsageError(`expected "latest" or a full 40-character lowercase sha, got "${target}"\n\n${USAGE}`);
  }
  return {
    target,
    root: resolve(parsed.values.root ?? join(homedir(), ".local", "share", "pollinate")),
    launchd: parsed.values.launchd === true,
    binDir: parsed.values.bin === undefined ? undefined : resolve(parsed.values.bin),
  };
}

let cachedToken;
function githubToken() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN?.trim() || null;
  if (!cachedToken) {
    try {
      cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim() || null;
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken;
}

function githubHeaders(accept) {
  const headers = { accept, "user-agent": "pollinate-install-runtime", "x-github-api-version": "2022-11-28" };
  const token = githubToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function nextPage(link) {
  return link?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
}

async function getJson(url) {
  const response = await fetch(url, { headers: githubHeaders("application/vnd.github+json") });
  if (!response.ok) throw new HttpError(response.status, `GET ${url}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return { body: await response.json(), next: nextPage(response.headers.get("link")) };
}

function installable(release) {
  const sha = release.tag_name?.match(/^runtime-([0-9a-f]{40})$/)?.[1];
  if (!sha || release.draft || release.prerelease) return undefined;
  const standalone = release.assets?.find((asset) => asset.name === standaloneName(sha));
  const sums = release.assets?.find((asset) => asset.name === "SHA256SUMS");
  if (!standalone || !sums) return undefined;
  return { sha, tag: release.tag_name, standalone, sums, createdAt: release.created_at ?? "", publishedAt: release.published_at ?? "" };
}

async function latestRelease() {
  const found = [];
  let url = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  while (url) {
    const page = await getJson(url);
    for (const release of page.body) {
      const candidate = installable(release);
      if (candidate) found.push(candidate);
    }
    url = page.next;
  }
  if (!found.length) throw new Error(`no runtime-* release in ${REPO} has a ${standaloneName("<sha>")} asset`);
  found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.publishedAt.localeCompare(a.publishedAt));
  return found[0];
}

async function releaseFor(sha) {
  let release;
  try {
    release = (await getJson(`https://api.github.com/repos/${REPO}/releases/tags/runtime-${sha}`)).body;
  } catch (error) {
    if (error.status === 404) throw new Error(`no release runtime-${sha} in ${REPO}`);
    throw error;
  }
  const candidate = installable(release);
  if (!candidate) throw new Error(`release runtime-${sha} is a draft or prerelease, or lacks ${standaloneName(sha)} or SHA256SUMS`);
  return candidate;
}

async function download(asset) {
  const response = await fetch(asset.url, { headers: githubHeaders("application/octet-stream") });
  if (!response.ok) throw new HttpError(response.status, `download ${asset.name}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

function expectedDigest(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (match && match[2] === name) return match[1];
  }
  throw new Error(`SHA256SUMS has no line for ${name}`);
}

function checkSymlinks(top, dir = top) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target)) throw new Error(`refusing ${relative(top, path)}: absolute symlink to ${target}`);
      if (relative(top, resolve(dirname(path), target)).startsWith("..")) throw new Error(`refusing ${relative(top, path)}: symlink to ${target} leaves the runtime`);
    } else if (stat.isDirectory()) {
      checkSymlinks(top, path);
    }
  }
}

function reportedCommit(dir) {
  const cli = join(dir, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`${cli} is missing`);
  let output;
  try {
    output = execFileSync(process.execPath, [cli, "--version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  } catch (error) {
    throw new Error(`${cli} --version --json failed: ${(error.stderr || error.stdout || error.message).toString().trim()}`);
  }
  return JSON.parse(output).commit;
}

function verifyInstalled(dir, sha) {
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory; move it aside and rerun`);
  const commit = reportedCommit(dir);
  if (commit !== sha) throw new Error(`${dir} exists but reports commit ${commit}; move it aside and rerun`);
}

async function installRelease(root, release) {
  const { sha } = release;
  const name = standaloneName(sha);
  const [tarball, sums] = await Promise.all([download(release.standalone), download(release.sums)]);
  const expected = expectedDigest(sums.toString("utf8"), name);
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected) throw new Error(`sha256 mismatch for ${name}: SHA256SUMS says ${expected}, downloaded file is ${actual}`);
  say(`downloaded ${name} (${tarball.length} bytes), sha256 ${actual} matches SHA256SUMS`);

  const top = `pollinate-${sha}`;
  const work = mkdtempSync(join(root, `.install-${sha.slice(0, 12)}-`));
  try {
    const tarPath = join(work, name);
    writeFileSync(tarPath, tarball);
    const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
    const stray = entries.find((entry) => !(entry === `${top}/` || entry.startsWith(`${top}/`)) || entry.split("/").includes(".."));
    if (stray !== undefined) throw new Error(`refusing ${name}: entry ${JSON.stringify(stray)} is outside ${top}/`);
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xzf", tarPath, "-C", unpacked, "--no-same-owner"]);
    const staged = join(unpacked, top);
    checkSymlinks(staged);
    const commit = reportedCommit(staged);
    if (commit !== sha) throw new Error(`${top}/dist/cli.js --version --json reports commit ${commit}, expected ${sha}`);
    const dir = join(root, sha);
    try {
      renameSync(staged, dir);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      verifyInstalled(dir, sha);
      say(`${dir} was installed meanwhile by another run`);
      return;
    }
    say(`installed ${dir} (${entries.length} entries, --version --json reports ${commit})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readSymlink(path) {
  try {
    return readlinkSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error.code === "EINVAL") throw new Error(`${path} exists and is not a symlink; move it aside and rerun`);
    throw error;
  }
}

function replaceSymlink(path, target) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}`);
  symlinkSync(target, temp);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function pointCurrent(root, sha) {
  const current = join(root, "current");
  const previous = readSymlink(current);
  if (previous === sha) {
    say(`${current} already -> ${sha}`);
    return false;
  }
  replaceSymlink(current, sha);
  say(`${current} -> ${sha} (previous: ${previous ?? "none"})`);
  if (previous !== undefined) say(`roll back with: ln -sfn ${shellQuote(previous)} ${shellQuote(current)} && pol daemon restart`);
  return true;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function rollbackDir(root) {
  const dir = join(root, "rollback");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function existingLaunchdSettings(path) {
  const store = process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate");
  if (!existsSync(path)) {
    return { node: process.execPath, env: { POLLINATE_STORE_ROOT: store }, out: join(store, "daemon.out.log"), err: join(store, "daemon.err.log") };
  }
  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
  const unknown = Object.keys(plist).filter((key) => !PLIST_KEYS.includes(key));
  const args = plist.ProgramArguments;
  const env = plist.EnvironmentVariables ?? {};
  const shaped =
    !unknown.length &&
    plist.Label === LABEL &&
    Array.isArray(args) &&
    args.length === 5 &&
    args.slice(2).join(" ") === "daemon run --foreground" &&
    plist.RunAtLoad === true &&
    plist.KeepAlive === true &&
    typeof plist.StandardOutPath === "string" &&
    typeof plist.StandardErrorPath === "string" &&
    Object.values(env).every((value) => typeof value === "string");
  if (!shaped) throw new Error(`${path} is not shaped like the plist "pol daemon install" writes; edit it by hand`);
  return { node: args[0], env, out: plist.StandardOutPath, err: plist.StandardErrorPath };
}

function renderPlist({ node, cli, env, out, err }) {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `<key>${xmlText(key)}</key><string>${xmlText(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlText(node)}</string>
    <string>${xmlText(cli)}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>${envEntries}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlText(out)}</string>
  <key>StandardErrorPath</key><string>${xmlText(err)}</string>
</dict>
</plist>
`;
}

function writeLaunchdPlist(root, stamp) {
  if (platform() !== "darwin") throw new Error("--launchd works on macOS only");
  const path = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const cli = join(root, "current", "dist", "cli.js");
  const next = renderPlist({ ...existingLaunchdSettings(path), cli });
  if (existsSync(path) && readFileSync(path, "utf8") === next) {
    say(`${path} already runs ${cli}`);
    return false;
  }
  if (existsSync(path)) {
    const backup = join(rollbackDir(root), `${LABEL}.plist.${stamp}`);
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    say(`saved the old plist to ${backup}`);
    say(
      `full rollback: cp ${shellQuote(backup)} ${shellQuote(path)}; launchctl bootout gui/$(id -u) ${shellQuote(path)}; launchctl bootstrap gui/$(id -u) ${shellQuote(path)}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${LABEL}.plist.${process.pid}.tmp`);
  writeFileSync(temp, next, { mode: 0o600 });
  chmodSync(temp, 0o600);
  try {
    execFileSync("plutil", ["-lint", "-s", temp], { stdio: ["ignore", "ignore", "pipe"] });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  say(`wrote ${path}: runs ${cli}`);
  return true;
}

function pointBins(root, binDir, stamp) {
  const cli = join(root, "current", "dist", "cli.js");
  const changes = [];
  for (const name of BIN_NAMES) {
    const path = join(binDir, name);
    const old = readSymlink(path);
    if (old === cli) say(`${path} already -> ${cli}`);
    else changes.push({ path, old });
  }
  if (!changes.length) return;
  const restore = join(rollbackDir(root), `bin-links.${stamp}.sh`);
  const lines = changes.map(({ path, old }) => (old === undefined ? `rm -f ${shellQuote(path)}` : `ln -sfn ${shellQuote(old)} ${shellQuote(path)}`));
  writeFileSync(restore, `${lines.join("\n")}\n`, { flag: "wx" });
  say(`saved the old bin targets to ${restore} (restore with: sh ${shellQuote(restore)})`);
  for (const { path, old } of changes) {
    replaceSymlink(path, cli);
    say(`${path} -> ${cli} (was ${old ?? "absent"})`);
  }
}

async function main() {
  const { target, root, launchd, binDir } = parseCommandLine();
  mkdirSync(root, { recursive: true });
  let release;
  let sha = target;
  if (target === "latest") {
    release = await latestRelease();
    sha = release.sha;
    say(`latest is ${release.tag}`);
  }
  const dir = join(root, sha);
  if (existsSync(dir)) {
    verifyInstalled(dir, sha);
    say(`${dir} is already installed; nothing downloaded`);
  } else {
    await installRelease(root, release ?? (await releaseFor(sha)));
  }
  const switched = pointCurrent(root, sha);
  const stamp = utcStamp();
  const rewrotePlist = launchd && writeLaunchdPlist(root, stamp);
  if (binDir) pointBins(root, binDir, stamp);
  if (switched || rewrotePlist) say("to run it: pol daemon restart");
}

main().catch((error) => {
  console.error(`install-runtime: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
