#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = join(root, "dist", "build-info.json");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function isOwnGitCheckout() {
  const toplevel = git(["rev-parse", "--show-toplevel"])?.trim();
  if (!toplevel) return false;
  try {
    return realpathSync(toplevel) === realpathSync(root);
  } catch {
    return false;
  }
}

function commitFromEnv() {
  const value = process.env.POLLINATE_BUILD_COMMIT?.trim();
  if (!value) return undefined;
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`POLLINATE_BUILD_COMMIT must be a 40-character hex commit sha, got "${value}"`);
  }
  return value.toLowerCase();
}

function commitFromGit() {
  if (!isOwnGitCheckout()) return { commit: null, dirty: null };
  const commit = git(["rev-parse", "HEAD"])?.trim();
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return { commit: null, dirty: null };
  const status = git(["status", "--porcelain"]);
  return { commit, dirty: status === undefined ? null : status.trim().length > 0 };
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const envCommit = commitFromEnv();
const { commit, dirty } = envCommit ? { commit: envCommit, dirty: null } : commitFromGit();

const info = {
  name: pkg.name,
  version: pkg.version,
  commit,
  dirty,
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${info.name} ${info.version} ${commit ?? "unknown commit"}${dirty ? " dirty" : ""}`);
