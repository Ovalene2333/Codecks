import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { DeckTool, ToolDescriptor } from "./types.js";

export interface TerminalLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
}

function powershellLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function terminalLaunchSpecs(
  cwd: string,
  platform = process.platform,
  useWsl = false,
  env: NodeJS.ProcessEnv = process.env,
): TerminalLaunchSpec[] {
  if (platform === "win32") {
    const wtArgs =
      useWsl && cwd.startsWith("/") ? ["wsl.exe", "--cd", cwd] : ["-d", cwd];
    const script =
      useWsl && cwd.startsWith("/")
        ? `Start-Process -FilePath 'wsl.exe' -ArgumentList '--cd',${powershellLiteral(cwd)}`
        : `Start-Process -FilePath 'cmd.exe' -WorkingDirectory ${powershellLiteral(cwd)}`;
    return [
      { command: "wt.exe", args: wtArgs },
      {
        command: env.SystemRoot
          ? path.join(
              env.SystemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            )
          : "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      },
    ];
  }
  if (platform === "darwin")
    return [{ command: "open", args: ["-a", "Terminal", cwd] }];

  const configured = env.TERMINAL?.trim();
  return [
    ...(configured ? [{ command: configured, args: [], cwd }] : []),
    { command: "x-terminal-emulator", args: [], cwd },
    { command: "gnome-terminal", args: [`--working-directory=${cwd}`] },
    { command: "konsole", args: ["--workdir", cwd] },
    { command: "xfce4-terminal", args: ["--working-directory", cwd] },
    { command: "xterm", args: [], cwd },
  ];
}

type SpawnFn = typeof spawn;

async function launch(spec: TerminalLaunchSpec, spawnFn: SpawnFn) {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(spec.command, spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class HostTerminalTool implements DeckTool {
  private lastLaunch = 0;

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      useWsl?: boolean;
      env?: NodeJS.ProcessEnv;
      spawn?: SpawnFn;
    } = {},
  ) {}

  descriptor(): ToolDescriptor {
    return {
      id: "host-terminal",
      name: "宿主机终端",
      description: "在运行 Codecks 的电脑上打开原生终端窗口",
      icon: "terminal",
      available: true,
    };
  }

  async run(input: Record<string, unknown>) {
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!cwd || cwd.length > 4_096) throw new Error("请选择有效的工作目录");
    const platform = this.options.platform || process.platform;
    const useWsl = Boolean(this.options.useWsl);
    const wslPath = platform === "win32" && useWsl && cwd.startsWith("/");
    if (!wslPath) {
      if (!path.isAbsolute(cwd)) throw new Error("工作目录必须是绝对路径");
      const info = await stat(cwd).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error("工作目录不存在或不是文件夹");
    }
    if (Date.now() - this.lastLaunch < 800)
      throw new Error("终端正在启动，请稍候");
    this.lastLaunch = Date.now();

    const errors: string[] = [];
    for (const spec of terminalLaunchSpecs(
      cwd,
      platform,
      useWsl,
      this.options.env,
    )) {
      try {
        await launch(spec, this.options.spawn || spawn);
        return { ok: true, toolId: "host-terminal", cwd };
      } catch (error: any) {
        errors.push(
          `${spec.command}: ${error?.code || error?.message || "启动失败"}`,
        );
      }
    }
    throw new Error(`没有可用的宿主机终端：${errors.join("；")}`);
  }
}
