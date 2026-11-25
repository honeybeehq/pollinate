import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type BuildCommit = { commit: string | null; dirty: boolean | null; version: string | null };

export function ownBuildInfoPath(): string {
  return fileURLToPath(new URL("./build-info.json", import.meta.url));
}

export async function readBuildCommit(path = ownBuildInfoPath()): Promise<BuildCommit | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return {
      commit: typeof raw.commit === "string" ? raw.commit : null,
      dirty: typeof raw.dirty === "boolean" ? raw.dirty : null,
      version: typeof raw.version === "string" ? raw.version : null,
    };
  } catch {
    return null;
  }
}
