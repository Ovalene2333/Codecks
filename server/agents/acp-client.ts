import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { killProcessTree, stopChildProcess } from "../process-tree.js";
import type { RpcMessage } from "../types.js";
import {
  ACP_PROTOCOL_VERSION,
  type AcpAgentCapabilities,
  type AcpInitializeResult,
} from "./acp-types.js";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface AcpLaunch {
  command: string;
  args: string[];
}

export interface AcpClientOptions {
  command: string;
  args?: string[];
  /** 附加环境变量（如 ACP agent 需要的凭据），并入子进程环境。 */
  env?: Record<string, string>;
  cwd?: string;
  /** 默认请求超时；session/prompt 长跑请求会单独放宽。 */
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => void;
}

/**
 * Windows 下 npm 安装的 CLI 多是 .cmd/.ps1 shim，必须经 cmd.exe 包装；
 * 真身 .exe 与 unix 路径则直接 spawn，避免 cmd 退出码失真。
 */
export function acpLaunchSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): AcpLaunch {
  if (/[\r\n]/.test(command)) throw new Error("ACP 启动命令不能包含换行符");
  if (platform !== "win32" || /\.exe$/i.test(command))
    return { command, args };
  if (/[\\/]/.test(command) || /\.(?:cmd|bat)$/i.test(command))
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  const pathValue = env.Path || env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, `${command}.exe`);
    if (existsSync(exe)) return { command: exe, args };
  }
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `${command}.cmd`, ...args],
  };
}

/**
 * ACP agent 子进程的 NDJSON JSON-RPC 传输。结构与 CodexClient 的 stdio
 * 模式一致：request/notify/respond 三分支，挂掉的进程统一走 fail()。
 *
 * 事件：
 * - "notification"：agent → client 通知（session/update 等），data=RpcMessage
 * - "request"：agent → client 请求（session/request_permission、fs/*、
 *   terminal/*），data=RpcMessage；处理方用 respond()/respondError() 回包
 * - "online" / "offline"(error message) / "log"(stderr 文本)
 */
export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private lineReader?: readline.Interface;
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private starting?: Promise<AcpInitializeResult>;
  private processOutput = "";
  private launchSummary = "";
  private failed = false;
  private stopping = false;
  online = false;
  lastError?: string;
  agentCapabilities: AcpAgentCapabilities = {};
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods: { id: string; name?: string; description?: string }[] = [];

  constructor(private options: AcpClientOptions) {
    super();
  }

  get pid() {
    return this.child?.pid;
  }

  start(): Promise<AcpInitializeResult> {
    if (this.online) {
      return Promise.resolve(this.initializeResult());
    }
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private initializeResult(): AcpInitializeResult {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: this.agentCapabilities,
      agentInfo: this.agentInfo,
      authMethods: this.authMethods,
    };
  }

  private async doStart(): Promise<AcpInitializeResult> {
    const launch = acpLaunchSpec(
      this.options.command,
      this.options.args || [],
      process.platform,
      process.env,
    );
    this.processOutput = "";
    this.failed = false;
    this.stopping = false;
    this.launchSummary = `${launch.command} ${launch.args.join(" ")}`;
    const spawnProcess = this.options.spawnProcess || spawn;
    const child = spawnProcess(launch.command, launch.args, {
      env: { ...process.env, ...(this.options.env || {}) },
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.once("error", (error) => this.fail(error));
    // stdin 在子进程死亡瞬间写入会触发 EPIPE；不挂监听就是未捕获异常。
    (child.stdin as unknown as { on?: (e: string, f: (e: Error) => void) => void })
      .on?.("error", (error) => {
        if (!this.stopping) this.fail(error);
      });
    child.once("exit", (code) => {
      if (!this.stopping)
        this.fail(new Error(`ACP agent 已退出 (${code ?? "unknown"})`));
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.processOutput = `${this.processOutput}${text}`.slice(-8_000);
      this.emit("log", text);
    });
    this.lineReader = readline
      .createInterface({ input: child.stdout })
      .on("line", (line) => {
        try {
          this.handle(JSON.parse(line));
        } catch {
          this.emit("log", `无法解析 ACP 输出: ${line}`);
        }
      });
    try {
      const result = (await this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: {
          name: "codex-deck",
          title: "Codecks",
          version: "0.2.0",
        },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })) as AcpInitializeResult;
      this.agentCapabilities = result?.agentCapabilities || {};
      this.agentInfo = result?.agentInfo;
      this.authMethods = Array.isArray(result?.authMethods)
        ? result.authMethods
        : [];
      this.online = true;
      this.lastError = undefined;
      this.emit("online");
      return this.initializeResult();
    } catch (error) {
      this.closeLineReader();
      this.killChild(child);
      if (this.child === child) this.child = undefined;
      throw error;
    }
  }

  async request(method: string, params?: any, timeout?: number): Promise<any> {
    if (!this.canSend()) throw new Error(`${this.options.command} 未运行`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeout ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${this.options.command} 未运行`));
      }
    });
  }

  notify(method: string, params?: any) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: any) {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string) {
    this.send({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.closeLineReader();
    this.killChild(child);
    this.online = false;
    const error = new Error("ACP agent 已停止");
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  private killChild(child: ChildProcessWithoutNullStreams | undefined) {
    if (!child) return;
    stopChildProcess(
      child,
      this.options.killProcessTree || killProcessTree,
    );
  }

  private closeLineReader() {
    try {
      this.lineReader?.close();
    } catch {
      // 忽略：流可能已经销毁。
    }
    this.lineReader = undefined;
  }

  private send(message: RpcMessage): boolean {
    const stdin = this.child?.stdin;
    if (
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded ||
      stdin.writable === false
    )
      return false;
    try {
      // 严格的 ACP 实现（如 devin 的 Rust jsonrpc actor）会拒绝缺少
      // jsonrpc:"2.0" 的消息，必须逐条带上。
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
      );
      return true;
    } catch {
      // 同步抛错时 'error' 事件随后也会触发走 fail()；这里只避免崩溃。
      return false;
    }
  }

  private canSend() {
    return Boolean(this.child?.stdin.writable);
  }

  private handle(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        // 严格 agent 对无法解析的入站行回 id:null 的错误（如 -32700
        // Parse error），无法按 id 关联到请求。只剩一个挂起请求时直接判
        // 它失败，否则只能干等超时且错误毫无踪迹。
        if (message.error) {
          const detail = message.error.message || "JSON-RPC 错误";
          this.emit("log", `agent 返回无法关联的错误: ${detail}`);
          if (this.pending.size === 1) {
            const [[key, item]] = this.pending;
            clearTimeout(item.timer);
            this.pending.delete(key);
            item.reject(new Error(detail));
          }
        }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message) as Error & {
          code?: number;
          data?: any;
        };
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method)
      this.emit("request", message);
    else if (message.method) this.emit("notification", message);
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.online = false;
    const detail = this.processOutput
      .trim()
      .split(/\r?\n/)
      .slice(-10)
      .join("\n");
    const wrapped = new Error(
      `${error.message}${
        this.launchSummary ? `\n启动命令: ${this.launchSummary}` : ""
      }${detail ? `\n${detail}` : ""}`,
    );
    this.lastError = wrapped.message;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(wrapped);
    }
    this.pending.clear();
    this.emit("offline", wrapped.message);
  }
}
