import { startCloudflareTunnel } from "./tunnel-cloudflare.js";
import { startCommandTunnel } from "./tunnel-command.js";
import type { ExposeSpec, TunnelController, TunnelOption } from "./tunnel-types.js";
import { accessUrl, normalizePublicOrigin } from "./tunnel-url.js";

export type {
  CloudflareTunnelOption,
  CommandTunnelOption,
  ExposeSpec,
  TunnelController,
  TunnelMode,
  TunnelOption,
} from "./tunnel-types.js";
export { cloudflaredArgs, resolveCloudflaredBin } from "./tunnel-cloudflare.js";
export {
  detectPublicOrigin,
  expandTunnelArgs,
  splitArgs,
} from "./tunnel-command.js";
export { accessUrl, normalizePublicOrigin } from "./tunnel-url.js";

export function parseExposeSpec(raw: string): ExposeSpec {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("--expose 缺少值");
  const colon = trimmed.indexOf(":");
  const head = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  const rest = colon === -1 ? "" : trimmed.slice(colon + 1);
  const provider = head === "cf" ? "cloudflare" : head;

  if (provider === "announce" || provider === "command") {
    if (rest) throw new Error(`--expose ${provider} 不接受额外参数`);
    return { provider };
  }

  if (provider === "cloudflare") {
    if (!rest || rest.toLowerCase() === "quick") {
      return { provider: "cloudflare", mode: "quick" };
    }
    const restLower = rest.toLowerCase();
    if (restLower === "share") return { provider: "cloudflare", mode: "share" };
    if (restLower === "named") return { provider: "cloudflare", mode: "named" };
    if (restLower.startsWith("named=")) {
      const name = rest.slice(rest.indexOf("=") + 1).trim();
      if (!name)
        throw new Error(
          "--expose cloudflare:named 需要指定 Tunnel 名称或 UUID",
        );
      return { provider: "cloudflare", mode: "named", name };
    }
    throw new Error(
      `未知的 Cloudflare 配置：${raw}。可用 cloudflare、cloudflare:quick、cloudflare:named、cloudflare:share。`,
    );
  }

  throw new Error(
    `未知的 --expose 供应商：${raw}。可用 announce、cloudflare、command。`,
  );
}

export function startAnnounceTunnel(
  origin: string,
  token: string,
): TunnelController {
  const normalized = normalizePublicOrigin(origin);
  process.stdout.write(`\n公网入口：\n${accessUrl(normalized, token)}\n\n`);
  return { kill() {} };
}

export function startTunnel(
  option: TunnelOption,
  port: number,
  token: string,
  cloudflaredBin?: string,
): TunnelController {
  if (option.provider === "announce")
    return startAnnounceTunnel(option.origin, token);
  if (option.provider === "command")
    return startCommandTunnel(option, port, token);
  return startCloudflareTunnel(option, port, token, cloudflaredBin);
}
