#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const problems = [];

for (const required of ["package.json", "dist/cli.js", "dist/build-info.json"]) {
  if (!existsSync(join(root, required))) problems.push(`missing ${required}`);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target)) problems.push(`absolute symlink ${relative(root, path)} -> ${target}`);
      else if (relative(root, resolve(dir, target)).startsWith("..")) problems.push(`symlink ${relative(root, path)} -> ${target} leaves the runtime`);
    } else if (stat.isDirectory()) {
      walk(path);
    }
  }
}
walk(root);

const pkg = readJson(join(root, "package.json"));
const modules = join(root, "node_modules");
const installed = new Set();
const pending = Object.keys(pkg.dependencies ?? {});
while (pending.length > 0) {
  const name = pending.pop();
  if (installed.has(name)) continue;
  const manifest = join(modules, name, "package.json");
  if (!existsSync(manifest)) {
    problems.push(`production dependency ${name} is not installed at node_modules/${name}`);
    continue;
  }
  installed.add(name);
  pending.push(...Object.keys(readJson(manifest).dependencies ?? {}));
}

const present = existsSync(modules)
  ? readdirSync(modules)
      .filter((name) => !name.startsWith("."))
      .flatMap((name) => (name.startsWith("@") ? readdirSync(join(modules, name)).map((inner) => `${name}/${inner}`) : [name]))
  : [];
for (const name of present) {
  if (!installed.has(name)) problems.push(`node_modules/${name} is not a production dependency`);
}
for (const name of Object.keys(pkg.devDependencies ?? {})) {
  if (existsSync(join(modules, name))) problems.push(`dev dependency ${name} is installed`);
}

if (problems.length > 0) {
  console.error(`standalone runtime ${root} is not shippable:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`standalone: ${[...installed].sort().join(", ")} (no dev dependencies, no absolute symlinks)`);
