import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { OfficialAuth } from "./official-auth.js";

export async function prepareRuntimeHome(
  runtimeHome: string,
  nativeHome: string,
  officialAuth: OfficialAuth,
) {
  await mkdir(runtimeHome, { recursive: true });
  if (existsSync(nativeHome)) {
    for (const entry of await readdir(nativeHome, { withFileTypes: true })) {
      if (entry.name === "auth.json" || entry.name === "config.toml") continue;
      if (!entry.isDirectory()) continue;
      const dest = path.join(runtimeHome, entry.name);
      if (existsSync(dest)) continue;
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(path.join(nativeHome, entry.name), dest, type);
    }
  }
  await writeFile(
    path.join(runtimeHome, "auth.json"),
    `${JSON.stringify(officialAuth, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return runtimeHome;
}
