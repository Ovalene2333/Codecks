import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";
import type { ConnectionOverlay, Provider, RpcMessage } from "./types.js";
import {
  compileRuntimeProvider,
  runtimeBootstrapArgs,
} from "./provider-config.js";
import { nativeWindowsSandboxMode } from "./runtime-home.js";
import {
  exposeEnvironmentToWsl,
  WSL_CODEX_SHELL_COMMAND,
} from "./runtime-platform.js";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
export interface LaunchSpec {
  command: string;
  args: string[];
}

export function codexRuntimeEnvironment(
  provider: Provider,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: provider.codexHome || path.join(os.homedir(), ".codex"),
  };
}

export function codexLaunchSpec(
  bin = "codex",
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  configArgs: string[] = [],
  listen = "stdio://",
  useWsl = false,
): LaunchSpec {
  const appArgs = [
    "app-server",
    ...(listen === "stdio://" ? ["--stdio"] : ["--listen", listen]),
    ...configArgs,
  ];
  if (platform === "win32" && useWsl) {
    if (/[\r\n]/.test(bin)) throw new Error("CODEX_BIN 不能包含换行符");
    const shell = env.CODEX_WSL_SHELL || "bash";
    if (/[\r\n]/.test(shell))
      throw new Error("CODEX_WSL_SHELL 不能包含换行符");
    return {
      command: env.WSL_EXE || "wsl.exe",
      args: [
        "--exec",
        shell,
        "-lc",
        WSL_CODEX_SHELL_COMMAND,
        "codex-deck",
        bin,
        ...appArgs,
      ],
    };
  }
  if (platform !== "win32" || /\.exe$/i.test(bin))
    return { command: bin, args: appArgs };
  if (/[\r\n]/.test(bin)) throw new Error("CODEX_BIN 不能包含换行符");

  // Prefer a real argv launch. Joining `-c` overrides into one `cmd /c`
  // string is re-quoted by Node and breaks `--listen`, so the runtime
  // port never opens.
  const resolved = resolveWindowsCodex(bin, env);
  if (resolved)
    return {
      command: resolved.command,
      args: [...resolved.prefix, ...appArgs],
    };

  const shell = env.ComSpec || env.COMSPEC || "cmd.exe";
  const windowsBin = /\.(?:cmd|bat)$/i.test(bin)
    ? bin
    : /[\\/]/.test(bin)
      ? bin
      : `${bin}.cmd`;
  return {
    command: shell,
    args: ["/d", "/s", "/c", windowsBin, ...appArgs],
  };
}

function resolveWindowsCodex(
  bin: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefix: string[] } | undefined {
  const candidates: string[] = [];
  if (/[\\/]/.test(bin) || /\.(?:cmd|bat)$/i.test(bin)) candidates.push(bin);
  else {
    const exe = findOnPath(`${bin}.exe`, env);
    if (exe) return { command: exe, prefix: [] };
    const cmd = findOnPath(`${bin}.cmd`, env);
    if (cmd) candidates.push(cmd);
    const bare = findOnPath(bin, env);
    if (bare) candidates.push(bare);
  }

  for (const candidate of candidates) {
    const js = findNpmCodexJs(candidate);
    if (js) return { command: process.execPath, prefix: [js] };
  }
  return undefined;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv) {
  const pathValue = env.Path || env.PATH;
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
}

function findNpmCodexJs(shim: string) {
  const dir = path.dirname(path.resolve(shim));
  const js = path.join(
    dir,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  return existsSync(js) ? js : undefined;
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting?: Promise<void>;
  online = false;
  lastError?: string;
  get pid() {
    return this.child?.pid;
  }
  private stderr = "";
  private processOutput = "";
  private launchSummary = "";
  private failed = false;
  private stopping = false;

  constructor(
    readonly provider: Provider,
    private dataDir: string,
    private codexBin = "codex",
    private runtimeProviders?: Provider[],
    readonly remoteUrl?: string,
    private useWsl = false,
    private overlayForProvider?: (
      providerId: string,
    ) => ConnectionOverlay | undefined,
  ) {
    super();
  }

  async start() {
    if (this.online) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart() {
    const env = codexRuntimeEnvironment(this.provider);
    const wslEnvNames = new Set(["CODEX_HOME"]);
    const configArgs: string[] = [];
    if (this.runtimeProviders) {
      const nativeHome =
        this.provider.codexHome || path.join(os.homedir(), ".codex");
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      const compiledProviders = this.runtimeProviders.map((item) =>
        compileRuntimeProvider(item, this.overlayForProvider?.(item.id)),
      );
      configArgs.push(...runtimeBootstrapArgs(compiledProviders));
      if (!this.useWsl) {
        const windowsSandbox = await nativeWindowsSandboxMode(nativeHome);
        if (windowsSandbox)
          configArgs.push("-c", `windows.sandbox='${windowsSandbox}'`);
      }
      for (const compiled of compiledProviders) {
        configArgs.push(...compiled.args);
        Object.assign(env, compiled.env);
        for (const name of Object.keys(compiled.env)) wslEnvNames.add(name);
      }
    }

    const launchEnv = this.useWsl
      ? exposeEnvironmentToWsl(env, wslEnvNames)
      : env;

    const launch = codexLaunchSpec(
      this.codexBin,
      process.platform,
      launchEnv,
      configArgs,
      this.remoteUrl || "stdio://",
      this.useWsl,
    );
    this.stderr = "";
    this.processOutput = "";
    this.failed = false;
    this.stopping = false;
    this.launchSummary = `${launch.command} ${launch.args.join(" ")}`;
    this.child = spawn(launch.command, launch.args, {
      env: launchEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code) => {
      if (!this.stopping)
        this.fail(new Error(`Codex app-server 已退出 (${code ?? "unknown"})`));
    });
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.stderr = `${this.stderr}${text}`.slice(-8_000);
      this.processOutput = `${this.processOutput}${text}`.slice(-8_000);
      this.emit("log", text);
    });
    if (this.remoteUrl)
      this.child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        this.processOutput = `${this.processOutput}${text}`.slice(-8_000);
        this.emit("log", text);
      });
    if (this.remoteUrl) {
      await this.connectSocket(this.remoteUrl);
    } else {
      readline
        .createInterface({ input: this.child.stdout })
        .on("line", (line) => {
          try {
            this.handle(JSON.parse(line));
          } catch {
            this.emit("log", `无法解析 app-server 输出: ${line}`);
          }
        });
    }
    await this.request("initialize", {
      clientInfo: { name: "codex-deck", title: "Codex Deck", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    this.online = true;
    this.lastError = undefined;
    this.emit("online");
  }

  async request(method: string, params?: any, timeout = 20_000): Promise<any> {
    if (!this.canSend()) throw new Error("Codex app-server 未运行");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: any) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: any) {
    this.send({ id, result });
  }

  stop() {
    this.stopping = true;
    const pid = this.child?.pid;
    if (pid && process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      this.child?.kill();
    }
    this.child = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.online = false;
    const error = new Error("Codex app-server 已停止");
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  private send(message: RpcMessage) {
    const data = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
    else this.child?.stdin.write(`${data}\n`);
  }

  private canSend() {
    return (
      this.socket?.readyState === WebSocket.OPEN ||
      Boolean(this.child?.stdin.writable)
    );
  }

  private async connectSocket(url: string) {
    const deadline = Date.now() + 20_000;
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      if (this.failed || this.child?.exitCode !== null) break;
      try {
        const socket = await new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(url);
          const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error("连接超时"));
          }, 1_000);
          ws.once("open", () => {
            clearTimeout(timer);
            resolve(ws);
          });
          ws.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        this.socket = socket;
        socket.on("message", (data) => {
          try {
            this.handle(JSON.parse(String(data)));
          } catch {
            this.emit("log", `无法解析 app-server WebSocket 输出`);
          }
        });
        socket.once("close", () => {
          if (!this.stopping)
            this.fail(new Error("Codex app-server WebSocket 已断开"));
        });
        return;
      } catch (error: any) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw this.connectFailure(lastError);
  }

  private connectFailure(lastError?: Error) {
    if (this.lastError) return new Error(this.lastError);
    const detail = this.processOutput
      .trim()
      .split(/\r?\n/)
      .slice(-10)
      .join("\n");
    const exit = this.child?.exitCode;
    const exitPart =
      exit === null || exit === undefined ? "" : `（进程已退出 ${exit}）`;
    return new Error(
      `无法连接 Codex runtime：${lastError?.message || "未知错误"}${exitPart}${
        this.launchSummary ? `\n启动命令: ${this.launchSummary}` : ""
      }${detail ? `\n${detail}` : ""}`,
    );
  }

  private handle(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
