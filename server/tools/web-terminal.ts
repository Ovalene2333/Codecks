import { stat } from "node:fs/promises";
import path from "node:path";
import * as pty from "node-pty";
import { z } from "zod";
import { WebSocket } from "ws";
import { windowsPathToWsl } from "../runtime-platform.js";
import type { DeckTool, ToolDescriptor } from "./types.js";

const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    cwd: z.string().trim().min(1).max(4_096),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(300),
  }),
  z.object({ type: z.literal("input"), data: z.string().max(64_000) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(300),
  }),
]);

export interface TerminalShellSpec {
  file: string;
  args: string[];
  cwd: string;
}

export function terminalShellSpec(
  cwd: string,
  options: {
    platform?: NodeJS.Platform;
    useWsl?: boolean;
    env?: NodeJS.ProcessEnv;
    processCwd?: string;
  } = {},
): TerminalShellSpec {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const processCwd = options.processCwd || process.cwd();
  if (platform === "win32" && options.useWsl) {
    const wslCwd = windowsPathToWsl(cwd);
    return {
      file: "wsl.exe",
      args: ["--cd", wslCwd],
      cwd: processCwd,
    };
  }
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoLogo"],
      cwd,
    };
  }
  return {
    file: env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
    args: ["-l"],
    cwd,
  };
}

type SpawnPty = typeof pty.spawn;

export class WebTerminalTool implements DeckTool {
  private sessions = new Set<pty.IPty>();
  private pendingSessions = 0;

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      useWsl?: boolean;
      env?: NodeJS.ProcessEnv;
      processCwd?: string;
      spawn?: SpawnPty;
      maxSessions?: number;
    } = {},
  ) {}

  descriptor(): ToolDescriptor {
    return {
      id: "terminal",
      name: "Web Terminal",
      description: "通过浏览器连接 Codecks Server 所在主机的交互式终端",
      icon: "terminal",
      available: true,
      pagePath: "/terminal",
      defaultCwd: this.options.processCwd || process.cwd(),
    };
  }

  connect(socket: WebSocket) {
    let terminal: pty.IPty | undefined;
    let starting = false;
    let closed = false;
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const dispose = () => {
      closed = true;
      if (!terminal) return;
      this.sessions.delete(terminal);
      try {
        terminal.kill();
      } catch {
        // The process may already have exited.
      }
      terminal = undefined;
    };

    socket.on("message", async (raw) => {
      try {
        if (closed) return;
        const payload = Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.isBuffer(raw)
            ? raw
            : Buffer.from(new Uint8Array(raw));
        if (payload.byteLength > 80_000) throw new Error("终端消息过大");
        const message = messageSchema.parse(JSON.parse(payload.toString()));
        if (message.type === "input") {
          terminal?.write(message.data);
          return;
        }
        if (message.type === "resize") {
          terminal?.resize(message.cols, message.rows);
          return;
        }
        if (terminal || starting) throw new Error("终端已经启动");
        if (
          this.sessions.size + this.pendingSessions >=
          (this.options.maxSessions || 8)
        )
          throw new Error("Web Terminal 并发数已达上限");
        starting = true;
        this.pendingSessions += 1;

        try {
          const spec = terminalShellSpec(message.cwd, this.options);
          const wslPath =
            (this.options.platform || process.platform) === "win32" &&
            this.options.useWsl &&
            message.cwd.startsWith("/");
          if (!wslPath) {
            if (!path.isAbsolute(message.cwd))
              throw new Error("工作目录必须是绝对路径");
            const info = await stat(message.cwd).catch(() => undefined);
            if (!info?.isDirectory())
              throw new Error("工作目录不存在或不是文件夹");
          }
          if (closed) throw new Error("终端连接已关闭");
          terminal = (this.options.spawn || pty.spawn)(spec.file, spec.args, {
            name: "xterm-256color",
            cols: message.cols,
            rows: message.rows,
            cwd: spec.cwd,
            env: this.options.env || process.env,
            useConpty: (this.options.platform || process.platform) === "win32",
          });
        } finally {
          starting = false;
          this.pendingSessions -= 1;
        }
        this.sessions.add(terminal);
        terminal.onData((data) => send({ type: "output", data }));
        terminal.onExit(({ exitCode, signal }) => {
          if (terminal) this.sessions.delete(terminal);
          terminal = undefined;
          send({ type: "exit", exitCode, signal });
          socket.close(1000, "terminal exited");
        });
        send({ type: "ready", pid: terminal.pid, cwd: message.cwd });
      } catch (error: any) {
        send({ type: "error", message: error?.message || "终端请求失败" });
      }
    });
    socket.once("close", dispose);
    socket.once("error", dispose);
  }

  close() {
    for (const terminal of this.sessions) {
      try {
        terminal.kill();
      } catch {
        // Shutdown continues even if a child already exited.
      }
    }
    this.sessions.clear();
  }
}
