import { readFile } from "node:fs/promises";

export const API_VERSION = 1;

export type BuildInfo = {
  name: string;
  version: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
};

export async function readVersion(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export async function readBuildInfo(): Promise<BuildInfo> {
  const fallback: BuildInfo = { name: "pollinate", version: await readVersion(), commit: null, dirty: null, builtAt: null };
  try {
    const text = await readFile(new URL("./build-info.json", import.meta.url), "utf8");
    const raw = JSON.parse(text) as Partial<Record<keyof BuildInfo, unknown>>;
    return {
      name: typeof raw.name === "string" ? raw.name : fallback.name,
      version: typeof raw.version === "string" ? raw.version : fallback.version,
      commit: typeof raw.commit === "string" ? raw.commit : null,
      dirty: typeof raw.dirty === "boolean" ? raw.dirty : null,
      builtAt: typeof raw.builtAt === "string" ? raw.builtAt : null,
    };
  } catch {
    return fallback;
  }
}
