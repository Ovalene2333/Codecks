import { isMainThread } from "node:worker_threads";
import { backgroundWork } from "./background-work.js";
import { cliProbeWork } from "./cli-probe-work.js";
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
  const commands =
    agent === "opencode" ? [agent, "opencode-v1", "opencode-v2"] : [agent];
  const names = commands.flatMap((name) =>
    platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name],
  );
  const extras =
    agent === "claude"
      ? [
          pathApi.join(home, ".claude", "local"),
          pathApi.join(home, ".claude", "bin"),
        ]
      : [
          pathApi.join(home, ".opencode", "bin"),
          pathApi.join(home, ".bun", "bin"),
        ];
  const pathDirs = (
    platform === "win32" ? env.Path || env.PATH || "" : env.PATH || ""
  )
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const versionDirs: string[] = [];
  if (agent === "opencode") {
    // 只检查当前用户的已知安装目录，不递归扫描配置、会话或其它用户目录。
    const roots = [
      [pathApi.join(home, ".opencode", "desktop-ssh"), ""],
      [pathApi.join(home, ".opencode", "versions"), ""],
      [
        pathApi.join(
          env.NVM_DIR || pathApi.join(home, ".nvm"),
          "versions",
          "node",
        ),
        "bin",
      ],
      [
        pathApi.join(
          env.FNM_DIR ||
            pathApi.join(
              env.XDG_DATA_HOME || pathApi.join(home, ".local", "share"),
              "fnm",
            ),
          "node-versions",
        ),
        pathApi.join("installation", "bin"),
      ],
    ];
    for (const [root, suffix] of roots) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^v?\d/.test(entry.name))
            versionDirs.push(pathApi.join(root, entry.name, suffix));
        }
      } catch {
        /* 该安装方式不存在。 */
      }
    }
  }
  const dirs = [
    ...pathDirs,
    pathApi.join(home, ".local", "bin"),
    ...(platform === "win32"
      ? [env.APPDATA ? pathApi.join(env.APPDATA, "npm") : ""]
      : ["/usr/local/bin"]),
    ...extras,
    ...(agent === "opencode"
      ? [
          pathApi.join(home, ".npm-global", "bin"),
          pathApi.join(home, ".local", "share", "npm", "bin"),
          ...(env.NPM_CONFIG_PREFIX || env.npm_config_prefix
            ? [
                platform === "win32"
                  ? (env.NPM_CONFIG_PREFIX || env.npm_config_prefix)!
                  : pathApi.join(
                      (env.NPM_CONFIG_PREFIX || env.npm_config_prefix)!,
                      "bin",
                    ),
              ]
            : []),
          env.BUN_INSTALL ? pathApi.join(env.BUN_INSTALL, "bin") : "",
          env.PNPM_HOME || "",
          env.NVM_BIN || "",
          ...versionDirs,
        ]
      : []),
  ].filter(Boolean);
  const candidates: { bin: string; source: LocalAgentBin["source"] }[] = [];
  const pinned = agent === "claude" ? env.CLAUDE_BIN : env.OPENCODE_BIN;
  if (pinned?.trim()) candidates.push({ bin: pinned.trim(), source: "env" });
  if (agent === "opencode" && env.OPENCODE_V2_BIN?.trim())
    candidates.push({ bin: env.OPENCODE_V2_BIN.trim(), source: "env" });
  for (const [index, dir] of dirs.entries()) {
    for (const name of names) {
      const bin = pathApi.join(dir, name);
      if (existsSync(bin))
        candidates.push({
          bin,
          source: index < pathDirs.length ? "path" : "standard",
        });
    }
  }
  if (agent === "claude") {
    // 原生安装器会保留各版本的可执行文件，启动别名只指向其中一个。
    const versions = pathApi.join(
      home,
      ".local",
      "share",
      "claude",
      "versions",
    );
    try {
      for (const name of readdirSync(versions)) {
        if (!/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(name)) continue;
        const bin = pathApi.join(versions, name);
        if (existsSync(bin)) candidates.push({ bin, source: "standard" });
      }
    } catch {
      /* 未安装原生版本。 */
    }
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
  return cliProbeWork(() => new Promise<string | undefined>((resolve) => {
    // Windows 的 npm shim 是 .cmd：execFile 不能直接执行批处理文件。
    const batch = platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
    if (batch && /[\r\n"%!]/.test(bin)) return resolve(undefined);
    const command = batch ? process.env.ComSpec || "cmd.exe" : bin;
    const args = batch
      ? ["/d", "/s", "/c", `call "${bin}" --version`]
      : ["--version"];
    execFile(
      command,
      args,
      { timeout, windowsHide: true, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) return resolve(undefined);
        // OpenCode 某些版本在版本号前输出日志；仅提取正常版本格式。
        resolve(
          /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/i.exec(
            `${stdout}\n${stderr}`,
          )?.[1],
        );
      },
    );
  }));
}

export async function listLocalAgentBins(agent: LocalAgent, saved = "") {
  const candidates = isMainThread
    ? await backgroundWork<ReturnType<typeof collectLocalAgentBins>>("agentBins", [agent, saved])
    : collectLocalAgentBins(agent, saved);
  const results = await Promise.all(
    candidates.map(async ({ bin, source }) => {
      const version = await probeLocalAgentBin(bin);
      return version ? { bin, version, source } : undefined;
    }),
  );
  return results.filter((item): item is LocalAgentBin => Boolean(item));
}
