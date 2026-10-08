import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OpenCodeConfigScope = "global" | "project";

export interface OpenCodeAgentPatch {
  model?: string | null;
  disable?: boolean | null;
  prompt?: string | null;
  temperature?: number | null;
}

export interface OpenCodeConfigUpdate {
  agent?: Record<string, OpenCodeAgentPatch>;
  model?: string | null;
  smallModel?: string | null;
}

export interface OpenCodeConfigFile {
  scope: OpenCodeConfigScope;
  /** 目标文件路径；不存在时是将要创建的 `opencode.json` 路径。 */
  path: string;
  exists: boolean;
  config: Record<string, any>;
}

const CONFIG_BASENAMES = ["opencode.json", "opencode.jsonc"];

/**
 * Deck 读写的全局配置目录，与 `opencode serve` 看到的一致：
 * `OPENCODE_CONFIG_DIR`（opencode 原生支持的额外全局配置目录）优先，
 * 其次 `XDG_CONFIG_HOME/opencode`，最后 `~/.config/opencode`。
 * serve 子进程直接继承 Deck 的环境，同一组变量对两边同时生效；
 * 沙箱/托管环境想让 serve 用另一份配置时显式设置这些变量即可，
 * Deck 不会根据 /etc/passwd 猜测别的 home。
 */
export function openCodeGlobalDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
) {
  if (env.OPENCODE_CONFIG_DIR)
    return path.resolve(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  return path.join(xdg, "opencode");
}

/**
 * 容忍 `.jsonc` 的解析：剥掉字符串之外的 `//` 与 `/* *\/` 注释，
 * 再去掉对象/数组尾逗号。`https://` 之类的 URL 在字符串内不受影响。
 */
export function parseJsonc(text: string): Record<string, any> {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // 尾逗号：`,` 之后（忽略空白）紧跟 `}` 或 `]` 时删去逗号。上一步已
  // 清掉注释，字符串原样保留，这里只需跳过字符串本身。
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned);
}

function configDir(scope: OpenCodeConfigScope, directory?: string) {
  if (scope === "global") return openCodeGlobalDir();
  if (!directory) throw new Error("项目范围必须提供 directory");
  return path.resolve(directory);
}

/**
 * 读取 opencode 配置。项目级优先 `opencode.json`，其次 `opencode.jsonc`；
 * 都没有时返回指向 `opencode.json` 的空配置，供写入时创建。
 * 全局与项目共用同一 schema，区别只在目录。
 */
export async function readOpenCodeConfig(
  scope: OpenCodeConfigScope,
  directory?: string,
): Promise<OpenCodeConfigFile> {
  const dir = configDir(scope, directory);
  for (const basename of CONFIG_BASENAMES) {
    const file = path.join(dir, basename);
    try {
      const text = await readFile(file, "utf8");
      const config = parseJsonc(text);
      return {
        scope,
        path: file,
        exists: true,
        config:
          config && typeof config === "object" && !Array.isArray(config)
            ? config
            : {},
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError)
        throw new Error(`${file} 解析失败：${error.message}`);
      throw error;
    }
  }
  return {
    scope,
    path: path.join(dir, "opencode.json"),
    exists: false,
    config: {},
  };
}

/**
 * 把 agent 补丁合并进配置文件。`null` 表示删除该键（恢复上游/默认），
 * `disable: false` 同样落成删除，保持文件干净。
 */
export async function writeOpenCodeConfig(
  scope: OpenCodeConfigScope,
  directory: string | undefined,
  update: OpenCodeConfigUpdate,
): Promise<OpenCodeConfigFile> {
  const file = await readOpenCodeConfig(scope, directory);
  const config = file.config;
  if (update.model !== undefined) {
    if (update.model === null) delete config.model;
    else config.model = update.model;
  }
  if (update.smallModel !== undefined) {
    if (update.smallModel === null) delete config.small_model;
    else config.small_model = update.smallModel;
  }
  if (update.agent) {
    const agents =
      config.agent && typeof config.agent === "object" ? config.agent : {};
    config.agent = agents;
    for (const [name, patch] of Object.entries(update.agent)) {
      const entry =
        agents[name] && typeof agents[name] === "object" ? agents[name] : {};
      agents[name] = entry;
      for (const key of ["model", "prompt", "temperature"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete entry[key];
        else entry[key] = value;
      }
      if (patch.disable !== undefined) {
        if (patch.disable) entry.disable = true;
        else delete entry.disable;
      }
      if (!Object.keys(entry).length) delete agents[name];
    }
    if (!Object.keys(agents).length) delete config.agent;
  }
  if (config.$schema === undefined && !file.exists)
    config.$schema = "https://opencode.ai/config.json";
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return { ...file, exists: true, config };
}
