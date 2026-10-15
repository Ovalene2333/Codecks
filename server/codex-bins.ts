import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 本机 Codex 后端发现：不硬编码任何机器绝对路径。
 *
 * 候选来源（按优先级）：
 * 1. 环境变量覆盖（`CODEX_BIN` / WSL 下的 `CODEX_WSL_BIN`）：最高优，显式指定。
 * 2. `PATH` 上的 `codex`：Deck 默认启动方式，启动时刻排第一的即被使用。
 * 3. 工具标准位置：npm 全局 bin、用户家目录下的 codex 包目录。
 * 4. 已持久化的历史选择（`runtime-config.json` 里的 `codexBin`）：仅当文件仍有效。
 *
 * 版本探测统一跑 `bin --version`（5 秒超时），失败的候选直接丢弃展示。
 */
export interface CodexBinCandidate {
  bin: string;
  version?: string;
  source: "env" | "path" | "npm-global" | "codex-packages" | "saved";
  alive: boolean;
}

function uniqueAlive(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function npmGlobalBinDirs(): string[] {
  const dirs: string[] = [];
  try {
    const prefix = process.env.NPM_CONFIG_PREFIX;
    if (prefix) dirs.push(path.join(prefix, "bin"));
  } catch {}
  const home = os.homedir();
  if (home) {
    dirs.push(path.join(home, ".npm-global", "bin"));
    // npm 默认全局 bin（linux）：~/.npm-global 只是常见覆盖，标准位置也顺带看一眼。
    dirs.push("/usr/local/bin");
  }
  return dirs;
}

/** 工具自带的标准包目录（codex 自身的 release 落点，非机器特定路径）。 */
function codexPackageDirs(): string[] {
  const home = os.homedir();
  if (!home) return [];
  return [path.join(home, ".codex", "packages")];
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathValue = env.Path || env.PATH;
  if (!pathValue) return [];
  const out: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate)) out.push(candidate);
    } catch {}
  }
  return out;
}

export function collectCodexBinCandidates(
  env: NodeJS.ProcessEnv = process.env,
  useWsl = false,
): { bin: string; source: CodexBinCandidate["source"] }[] {
  const out: { bin: string; source: CodexBinCandidate["source"] }[] = [];
  const envBin = useWsl ? env.CODEX_WSL_BIN : env.CODEX_BIN;
  if (envBin?.trim()) out.push({ bin: envBin.trim(), source: "env" });
  // PATH 上的 codex（含 Windows 的 cmd/exe 变体）。
  const names =
    process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const name of names) {
    for (const found of findOnPath(name, env))
      out.push({ bin: found, source: "path" });
  }
  if (!useWsl) {
    for (const dir of npmGlobalBinDirs()) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (existsSync(candidate)) out.push({ bin: candidate, source: "npm-global" });
        } catch {}
      }
    }
    for (const dir of codexPackageDirs()) {
      const hits = scanCodexPackages(dir);
      for (const hit of hits) out.push({ bin: hit, source: "codex-packages" });
    }
  }
  const deduped = new Map<string, CodexBinCandidate["source"]>();
  for (const item of out) {
    if (!deduped.has(item.bin)) deduped.set(item.bin, item.source);
  }
  return [...deduped.entries()].map(([bin, source]) => ({ bin, source }));
}

function scanCodexPackages(root: string): string[] {
  // ~/.codex/packages/.../bin/codex：只认“以 bin/codex 结尾”的可执行文件，
  // 不假设中间 releases 目录的具体命名（含版本号的目录名不解析，只透传）。
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry === "bin") {
        for (const name of ["codex", "codex.exe"]) {
          const candidate = path.join(full, name);
          try {
            if (existsSync(candidate)) found.push(candidate);
          } catch {}
        }
        continue;
      }
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {}
    }
  };
  try {
    if (existsSync(root)) walk(root, 0);
  } catch {}
  return found;
}

export function parseCodexVersion(output: string): string | undefined {
  const match = String(output || "").match(/codex-cli\s+([0-9][\w.+-]*)/i);
  return match?.[1];
}

export function probeCodexVersion(
  bin: string,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
    try {
      execFile(bin, ["--version"], { timeout: timeoutMs }, (error, stdout, stderr) => {
        clearTimeout(timer);
        if (error) return finish(undefined);
        finish(parseCodexVersion(`${stdout}\n${stderr}`));
      });
    } catch {
      clearTimeout(timer);
      finish(undefined);
    }
  });
}

export async function listCodexBinCandidates(
  env: NodeJS.ProcessEnv = process.env,
  useWsl = false,
  savedBin?: string,
): Promise<CodexBinCandidate[]> {
  const collected = collectCodexBinCandidates(env, useWsl);
  if (savedBin?.trim() && !collected.some((item) => item.bin === savedBin.trim()))
    collected.push({ bin: savedBin.trim(), source: "saved" });
  const probed = await Promise.all(
    collected.map(async (item) => {
      const version = await probeCodexVersion(item.bin);
      return {
        bin: item.bin,
        source: item.source,
        version,
        alive: version !== undefined,
      } satisfies CodexBinCandidate;
    }),
  );
  // 活的排前面；同源保持发现顺序。
  return probed
    .filter((item) => item.alive)
    .sort((a, b) => Number(b.alive) - Number(a.alive));
}

/**
 * 生效的后端：环境变量 > 已保存的选择（仍有效）> PATH 默认。
 * 返回空字符串表示沿用 `codex`（PATH 解析），与旧行为一致。
 */
export function resolveEffectiveCodexBin(
  env: NodeJS.ProcessEnv = process.env,
  useWsl = false,
  savedBin?: string,
): string {
  const envBin = (useWsl ? env.CODEX_WSL_BIN : env.CODEX_BIN)?.trim();
  if (envBin) return envBin;
  if (savedBin?.trim()) {
    try {
      if (existsSync(savedBin.trim())) return savedBin.trim();
    } catch {}
  }
  return "";
}

export { uniqueAlive };
