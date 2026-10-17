import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { windowsPathToWsl } from "../../server/runtime-platform.js";
import type { DeckTool, ToolDescriptor } from "../server-registry.js";
import {
  QUICK_COMMAND_PARAM_RE,
  commandParamNames,
  type QuickCommand,
  type QuickCommandResult,
} from "./quick-command.types.js";

const MAX_ITEMS = 200;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 600_000;

const cwdSchema = z.string().trim().min(1).max(4_096);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("save"),
    id: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1).max(4_000),
    /** 绑定的目录；空字符串在更新时表示清除绑定。 */
    cwd: z.string().trim().max(4_096).optional(),
  }),
  z.object({
    action: z.literal("remove"),
    id: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal("exec"),
    cwd: cwdSchema,
    command: z.string().trim().min(1).max(4_000),
    params: z.record(z.string().max(120), z.string().max(4_000)).optional(),
    timeoutMs: z.number().int().min(1_000).max(DEFAULT_TIMEOUT_MS).optional(),
  }),
]);

export interface QuickCommandShellSpec {
  file: string;
  args: string[];
  cwd: string;
}

export interface QuickCommandExecOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
}

type ExecShell = (
  spec: QuickCommandShellSpec,
  timeoutMs: number,
) => Promise<QuickCommandExecOutcome>;

/** POSIX / WSL 共用 sh 单引号转义：' → '"'"' */
export const shQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
/** PowerShell 单引号字符串内 ' 写成 '' */
export const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** 把命令模板里的 `{参数名}` 替换为 shell 转义后的参数值；缺占位符保持原样。 */
export function expandQuickCommand(
  command: string,
  params: Record<string, string>,
  quote: (value: string) => string,
) {
  return command.replace(QUICK_COMMAND_PARAM_RE, (raw, name: string) =>
    params[name] === undefined ? raw : quote(params[name]),
  );
}

/** 起 shell 执行命令串：POSIX 用用户 shell -lc，WSL 走 wsl.exe --cd，Windows 用 PowerShell。 */
export function quickCommandShellSpec(
  cwd: string,
  command: string,
  options: {
    platform?: NodeJS.Platform;
    useWsl?: boolean;
    env?: NodeJS.ProcessEnv;
    processCwd?: string;
  } = {},
): QuickCommandShellSpec {
  const platform = options.platform || process.platform;
  if (platform === "win32" && options.useWsl)
    return {
      file: "wsl.exe",
      args: [
        "--cd",
        windowsPathToWsl(cwd),
        "--exec",
        "sh",
        "-lc",
        command,
      ],
      cwd: options.processCwd || process.cwd(),
    };
  if (platform === "win32")
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NonInteractive", "-Command", command],
      cwd,
    };
  const env = options.env || process.env;
  return {
    file:
      env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
    args: ["-lc", command],
    cwd,
  };
}

function truncate(value: string) {
  return value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n… 输出过长已截断 …`
    : value;
}

export class QuickCommandTool implements DeckTool {
  private items: QuickCommand[] = [];
  private loading?: Promise<void>;
  private writes = Promise.resolve();

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      useWsl?: boolean;
      env?: NodeJS.ProcessEnv;
      processCwd?: string;
      /** 指令持久化文件；缺省只存内存（测试用）。 */
      file?: string;
      exec?: ExecShell;
      timeoutMs?: number;
      now?: () => number;
    } = {},
  ) {}

  descriptor(): ToolDescriptor {
    return {
      id: "commands",
      name: "快捷指令",
      description:
        "在指定目录一键执行常用指令，命令里可用 {参数名} 占位符带参执行",
      icon: "zap",
      available: true,
      pagePath: "/commands",
      defaultCwd: this.options.processCwd || process.cwd(),
    };
  }

  private ensureLoaded() {
    this.loading ||= (async () => {
      if (!this.options.file) return;
      try {
        const parsed = JSON.parse(await readFile(this.options.file, "utf8"));
        if (parsed?.version === 1 && Array.isArray(parsed.items))
          this.items = parsed.items.flatMap((item: any) =>
            item &&
            typeof item.id === "string" &&
            typeof item.name === "string" &&
            typeof item.command === "string"
              ? [
                  {
                    id: item.id,
                    name: item.name,
                    command: item.command,
                    cwd:
                      typeof item.cwd === "string" && item.cwd
                        ? item.cwd
                        : undefined,
                    createdAt: Number(item.createdAt) || Date.now(),
                    updatedAt: Number(item.updatedAt) || Date.now(),
                  } satisfies QuickCommand,
                ]
              : [],
          );
      } catch (error: any) {
        // 脏文件不覆盖：沿用内存空表，原文件保留待人工修复。
        if (error?.code !== "ENOENT")
          console.error(
            "快捷指令文件损坏，已回退为空（原文件保留）:",
            error?.message || error,
          );
      }
    })();
    return this.loading;
  }

  private persist() {
    const file = this.options.file;
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify({ version: 1, items: this.items });
    const attempt = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    });
    this.writes = attempt.catch(() => undefined);
    return attempt;
  }

  private list() {
    return [...this.items].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
  }

  private async saveCommand(input: {
    id?: string;
    name: string;
    command: string;
    cwd?: string;
  }) {
    const now = (this.options.now || Date.now)();
    const existing = input.id
      ? this.items.find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("快捷指令不存在");
    const item: QuickCommand = {
      id: existing?.id || randomUUID(),
      name: input.name,
      command: input.command,
      cwd: input.cwd || undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (existing)
      this.items = this.items.map((entry) =>
        entry.id === item.id ? item : entry,
      );
    else {
      if (this.items.length >= MAX_ITEMS)
        throw new Error(`快捷指令最多保存 ${MAX_ITEMS} 条`);
      this.items = [...this.items, item];
    }
    await this.persist();
    return { commands: this.list(), saved: item };
  }

  private async removeCommand(id: string) {
    if (!this.items.some((item) => item.id === id))
      throw new Error("快捷指令不存在");
    this.items = this.items.filter((item) => item.id !== id);
    await this.persist();
    return { commands: this.list() };
  }

  private async resolveCwd(cwd: string) {
    const platform = this.options.platform || process.platform;
    if (platform === "win32" && this.options.useWsl) {
      // WSL 内路径 Windows 侧 stat 不到，交给 wsl --cd 自己报错。
      if (cwd.startsWith("/") || path.win32.isAbsolute(cwd)) return cwd;
      throw new Error("工作目录必须是绝对路径");
    }
    const absolute =
      platform === "win32"
        ? path.win32.isAbsolute(cwd)
        : path.posix.isAbsolute(cwd);
    if (!absolute) throw new Error("工作目录必须是绝对路径");
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error("工作目录不存在或不是文件夹");
    return cwd;
  }

  private defaultExec: ExecShell = (spec, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        spec.file,
        spec.args,
        {
          cwd: spec.cwd,
          env: this.options.env || process.env,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
              code: 0,
              timedOut: false,
              truncated: false,
            });
            return;
          }
          // ENOENT/EACCES 这类 spawn 级失败才算异常（code 是字符串且进程没跑起来，
          // killed=false）；进程非零退出、超时、maxBuffer 截断都作为正常结果带回。
          if (typeof error.code === "string" && !error.killed) {
            reject(new Error(`无法启动命令：${error.message}`));
            return;
          }
          const note = `${String(error.code || "")} ${error.message}`;
          resolve({
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            code: typeof error.code === "number" ? error.code : null,
            signal: error.signal || undefined,
            timedOut: /timed out/i.test(note),
            truncated: /maxBuffer|ENOBUFS|OUT_OF_RANGE/i.test(note),
          });
        },
      );
    });

  private async execCommand(input: {
    cwd: string;
    command: string;
    params?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<QuickCommandResult> {
    const cwd = await this.resolveCwd(input.cwd);
    const missing = commandParamNames(input.command).filter(
      (name) => input.params?.[name] === undefined,
    );
    if (missing.length) throw new Error(`缺少参数：${missing.join("、")}`);
    const platform = this.options.platform || process.platform;
    const quote = platform === "win32" && !this.options.useWsl ? psQuote : shQuote;
    const command = expandQuickCommand(input.command, input.params || {}, quote);
    const spec = quickCommandShellSpec(cwd, command, this.options);
    const started = Date.now();
    const outcome = await (this.options.exec || this.defaultExec)(
      spec,
      Math.min(input.timeoutMs || this.options.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    );
    const truncated =
      outcome.truncated ||
      outcome.stdout.length > MAX_OUTPUT_CHARS ||
      outcome.stderr.length > MAX_OUTPUT_CHARS;
    return {
      command,
      cwd,
      code: outcome.code,
      signal: outcome.signal,
      stdout: truncate(outcome.stdout),
      stderr: truncate(outcome.stderr),
      durationMs: Date.now() - started,
      timedOut: outcome.timedOut,
      truncated,
    };
  }

  async run(input: Record<string, unknown>) {
    const request = requestSchema.parse(input);
    await this.ensureLoaded();
    switch (request.action) {
      case "list":
        return { commands: this.list() };
      case "save":
        return this.saveCommand(request);
      case "remove":
        return this.removeCommand(request.id);
      case "exec":
        return this.execCommand(request);
    }
  }
}
