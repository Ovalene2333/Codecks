import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

export interface TunnelController {
  kill(): void;
}
export type TunnelMode = { mode: "quick" } | { mode: "named"; name: string };

export function resolveCloudflaredBin(explicit?: string) {
  const candidates = [
    explicit?.trim(),
    process.env.CODEX_DECK_CLOUDFLARED?.trim(),
    "cloudflared",
    "cloudflared.exe",
    "/mnt/d/software/cloudflared/cloudflared.exe",
    "D:\\software\\cloudflared\\cloudflared.exe",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (
      candidate === "cloudflared" ||
      candidate === "cloudflared.exe" ||
      existsSync(candidate)
    )
      return candidate;
  }
  return "cloudflared";
}

export function cloudflaredArgs(mode: TunnelMode, port: number) {
  return mode.mode === "quick"
    ? [
        "tunnel",
        "--url",
        `http://127.0.0.1:${port}`,
        "--protocol",
        process.env.CODEX_DECK_TUNNEL_PROTOCOL || "http2",
      ]
    : ["tunnel", "--url", `http://127.0.0.1:${port}`, "run", mode.name];
}

export function startTunnel(
  mode: TunnelMode,
  port: number,
  token: string,
  binary?: string,
): TunnelController {
  const bin = resolveCloudflaredBin(binary);
  let active: ChildProcessWithoutNullStreams | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;

  const launch = () => {
    if (stopped) return;
    const args = cloudflaredArgs(mode, port);
    process.stdout.write(
      mode.mode === "quick"
        ? "正在创建 Cloudflare 临时隧道…\n"
        : `正在连接 Cloudflare Named Tunnel：${mode.name}\n`,
    );
    const child = spawn(bin, args, {
      stdio: "pipe",
      windowsHide: true,
      env: process.env,
    });
    active = child;
    let output = "";
    let ready = false;
    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = `${output}${text}`.slice(-20_000);
      const quickUrl = output.match(
        /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
      )?.[0];
      if (quickUrl && !ready) {
        ready = true;
        failures = 0;
        process.stdout.write(
          `\nCloudflare 临时入口：\n${accessUrl(quickUrl, token)}\n\n`,
        );
      }
      if (
        mode.mode === "named" &&
        !ready &&
        /Registered tunnel connection/i.test(output)
      ) {
        ready = true;
        failures = 0;
        process.stdout.write(`Named Tunnel 已连接：${mode.name}\n`);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      process.stderr.write(
        `无法启动 cloudflared（${bin}）：${error.message}\n请安装 cloudflared 或使用 --cloudflared 指定路径。\n`,
      );
    });
    child.once("close", (code) => {
      if (active === child) active = undefined;
      if (stopped) return;
      failures++;
      if (failures > 3) {
        process.stderr.write(
          `Cloudflare Tunnel 连续失败 3 次，最后退出代码 ${code ?? "未知"}。\n${logTail(output)}\n`,
        );
        return;
      }
      const delay = failures === 1 ? 2_000 : 5_000;
      process.stderr.write(
        `Cloudflare Tunnel 已断开，${delay / 1000} 秒后重连（${failures}/3）。\n`,
      );
      retry = setTimeout(launch, delay);
    });
  };
  launch();
  return {
    kill() {
      stopped = true;
      if (retry) clearTimeout(retry);
      active?.kill();
    },
  };
}

export function accessUrl(origin: string, token: string) {
  const base = `${origin.replace(/\/$/, "")}/`;
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}

function logTail(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-12)
    .join("\n");
}
