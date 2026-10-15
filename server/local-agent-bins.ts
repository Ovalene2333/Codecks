import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalAgent = "claude" | "opencode";
export interface LocalAgentBin {
  bin: string;
  version: string;
  source: "env" | "path" | "standard" | "saved";
}

/** 只枚举当前用户及 PATH 中的 CLI；别名和版本文件分列，前者跟随更新，后者固定版本。 */
export function collectLocalAgentBins(
  agent: LocalAgent,
  saved = "",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): { bin: string; source: LocalAgentBin["source"] }[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32"
    ? [`${agent}.exe`, `${agent}.cmd`, agent]
    : [agent];
  const extras = agent === "claude"
    ? [pathApi.join(home, ".claude", "local"), pathApi.join(home, ".claude", "bin")]
    : [pathApi.join(home, ".opencode", "bin"), pathApi.join(home, ".bun", "bin")];
  const pathDirs = (env.Path || env.PATH || "").split(platform === "win32" ? ";" : ":");
  const dirs = [
    ...pathDirs,
    pathApi.join(home, ".local", "bin"),
    ...(platform === "win32"
      ? [env.APPDATA ? pathApi.join(env.APPDATA, "npm") : ""]
      : ["/usr/local/bin"]),
    ...extras,
  ].filter(Boolean);
  const candidates: { bin: string; source: LocalAgentBin["source"] }[] = [];
  const pinned = agent === "claude" ? env.CLAUDE_BIN : env.OPENCODE_BIN;
  if (pinned?.trim()) candidates.push({ bin: pinned.trim(), source: "env" });
  for (const [index, dir] of dirs.entries()) {
    for (const name of names) {
      const bin = pathApi.join(dir, name);
      if (existsSync(bin))
        candidates.push({ bin, source: index < pathDirs.length ? "path" : "standard" });
    }
  }
  if (agent === "claude") {
    // 原生安装器会保留各版本的可执行文件，启动别名只指向其中一个。
    const versions = pathApi.join(home, ".local", "share", "claude", "versions");
    try {
      for (const name of readdirSync(versions)) {
        if (!/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(name)) continue;
        const bin = pathApi.join(versions, name);
        if (existsSync(bin)) candidates.push({ bin, source: "standard" });
      }
    } catch { /* 未安装原生版本。 */ }
  }
  if (saved.trim()) candidates.push({ bin: saved.trim(), source: "saved" });
  const seen = new Set<string>();
  return candidates.filter(({ bin }) => {
    if (seen.has(bin)) return false;
    seen.add(bin);
    return true;
  });
}

export function probeLocalAgentBin(
  bin: string,
  timeout = 5_000,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Windows 的 npm shim 是 .cmd：execFile 不能直接执行批处理文件。
    const batch = platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
    if (batch && /[\r\n"%!]/.test(bin)) return resolve(undefined);
    const command = batch ? process.env.ComSpec || "cmd.exe" : bin;
    const args = batch
      ? ["/d", "/s", "/c", `call "${bin}" --version`]
      : ["--version"];
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(undefined);
      // OpenCode 某些版本在版本号前输出日志；仅提取正常版本格式。
      resolve(/\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(`${stdout}\n${stderr}`)?.[1]);
    });
  });
}

export async function listLocalAgentBins(agent: LocalAgent, saved = "") {
  const candidates = collectLocalAgentBins(agent, saved);
  const results = await Promise.all(candidates.map(async ({ bin, source }) => {
    const version = await probeLocalAgentBin(bin);
    return version ? { bin, version, source } : undefined;
  }));
  return results.filter((item): item is LocalAgentBin => Boolean(item));
}
