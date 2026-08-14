import { existsSync } from "node:fs";
import { startManagedTunnel } from "./tunnel-process.js";
import type {
  CloudflareTunnelOption,
  TunnelController,
} from "./tunnel-types.js";
import { accessUrl, normalizePublicOrigin } from "./tunnel-url.js";

export function resolveCloudflaredBin(explicit?: string) {
  const candidates = [
    explicit?.trim(),
    process.env.CODEX_DECK_CLOUDFLARED?.trim(),
    "cloudflared",
    "cloudflared.exe",
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

export function cloudflaredArgs(mode: CloudflareTunnelOption, port: number) {
  if (mode.mode === "quick")
    return [
      "tunnel",
      "--url",
      `http://127.0.0.1:${port}`,
      "--protocol",
      process.env.CODEX_DECK_TUNNEL_PROTOCOL || "http2",
    ];
  if (mode.mode === "share") return ["tunnel", "run", "--token", mode.tunnelToken];
  return ["tunnel", "--url", `http://127.0.0.1:${port}`, "run", mode.name];
}

export function startCloudflareTunnel(
  mode: CloudflareTunnelOption,
  port: number,
  token: string,
  binary?: string,
): TunnelController {
  const bin = resolveCloudflaredBin(binary);
  const fixedOrigin =
    mode.mode === "share"
      ? normalizePublicOrigin(mode.hostname)
      : mode.mode === "named" && mode.origin
        ? normalizePublicOrigin(mode.origin)
        : undefined;

  return startManagedTunnel({
    bin,
    args: cloudflaredArgs(mode, port),
    env: {
      TUNNEL_TRANSPORT_PROTOCOL:
        process.env.CODEX_DECK_TUNNEL_PROTOCOL || "http2",
    },
    startingMessage:
      mode.mode === "quick"
        ? "正在创建 Cloudflare 临时隧道…\n"
        : mode.mode === "share"
          ? `正在连接 Cloudflare Named Tunnel（固定域名 ${fixedOrigin}）…\n`
          : `正在连接 Cloudflare Named Tunnel：${mode.name}\n`,
    missingBinHint: "请安装 cloudflared 或使用 --cloudflared 指定路径。",
    label: "Cloudflare Tunnel",
    detectReady: (output) => {
      if (mode.mode === "quick") {
        return output.match(
          /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
        )?.[0];
      }
      if (/Registered tunnel connection/i.test(output)) return true;
    },
    onReady: (origin) => {
      if (mode.mode === "quick") {
        if (origin) {
          process.stdout.write(
            `\nCloudflare 临时入口：\n${accessUrl(origin, token)}\n\n`,
          );
        }
        return;
      }
      if (mode.mode === "share" && fixedOrigin) {
        process.stdout.write(
          `\nNamed Tunnel 已连接：${fixedOrigin}\n公网入口：\n${accessUrl(fixedOrigin, token)}\n\n`,
        );
        return;
      }
      if (mode.mode !== "named") return;
      process.stdout.write(`Named Tunnel 已连接：${mode.name}\n`);
      if (fixedOrigin) {
        process.stdout.write(
          `公网入口：\n${accessUrl(fixedOrigin, token)}\n\n`,
        );
      }
    },
  });
}
