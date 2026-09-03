import os from "node:os";
import type { DdnsOption, TunnelController } from "./tunnel-types.js";
import { directUrl, normalizePublicOrigin } from "./tunnel-url.js";
import { isUsableIpv6 } from "./network.js";
import { printQrCode } from "./terminal-qr.js";

const FETCH_TIMEOUT_MS = 8_000;

/**
 * Global unicast IPv6 of the host (the one the upstream router routes), or
 * undefined when none is configured. Node's interface list does not expose
 * scope flags, so prefer the last candidate: on most systems the public
 * (non-privacy) address is reported after the temporary one.
 */
export function detectIpv6(interfaces = os.networkInterfaces()): string | undefined {
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces))
    for (const item of entries || []) {
      if (item.family === "IPv6" && !item.internal && isUsableIpv6(item.address))
        candidates.push(item.address);
    }
  return candidates[candidates.length - 1];
}

/**
 * Public IPv4 as seen from the outside (required for DDNS because local
 * interfaces report the private LAN address behind NAT). Falls back across
 * a few well-known plain-text services.
 */
export async function detectPublicIpv4(): Promise<string | undefined> {
  const services = [
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://ifconfig.me/ip",
  ];
  for (const url of services) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text) && text !== "0.0.0.0")
        return text;
    } catch {
      // try the next service
    }
  }
  return undefined;
}

export function startDdns(
  option: DdnsOption,
  token: string,
  port: number,
): TunnelController {
  normalizePublicOrigin(option.host);
  const entry = directUrl(option.host, port, token);
  process.stdout.write(`\nDDNS 入口：\n${entry}\n`);
  printQrCode(entry);
  let stopped = false;
  const sync = async () => {
    if (stopped) return;
    try {
      const result = await syncDdns(option);
      process.stdout.write(
        `DDNS 同步（${option.provider}）：${result.lines.join("，") || "地址未变化"}\n`,
      );
    } catch (error: any) {
      process.stderr.write(`DDNS 同步失败：${error?.message || error}\n`);
    }
  };
  void sync();
  const interval = Math.max(1, option.intervalMinutes) * 60_000;
  const timer = setInterval(sync, interval);
  timer.unref();
  return {
    kill() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function syncDdns(option: DdnsOption): Promise<SyncResult> {
  const ipv4 = await resolveAddress(option.ipv4, "ipv4");
  const ipv6 = await resolveAddress(option.ipv6, "ipv6");
  if (!ipv4 && !ipv6) {
    return { updated: false, lines: ["未检测到可用的公网地址"] };
  }
  return option.provider === "duckdns"
    ? syncDuckdns(option, ipv4, ipv6)
    : syncCloudflare(option, ipv4, ipv6);
}

interface SyncResult {
  updated: boolean;
  lines: string[];
}

async function resolveAddress(
  setting: "auto" | "none" | string,
  family: "ipv4" | "ipv6",
): Promise<string | undefined> {
  if (setting === "none") return undefined;
  if (setting === "auto") {
    return family === "ipv4" ? detectPublicIpv4() : detectIpv6();
  }
  return setting;
}

async function syncDuckdns(
  option: DdnsOption,
  ipv4?: string,
  ipv6?: string,
): Promise<SyncResult> {
  const params = new URLSearchParams({
    domains: option.host.toLowerCase().replace(/\.duckdns\.org$/, ""),
    token: option.token,
    verbose: "true",
  });
  if (ipv4) params.set("ip", ipv4);
  if (ipv6) params.set("ipv6", ipv6);
  const response = await fetch(`https://www.duckdns.org/update?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await response.text()).trim().split("\n")[0];
  if (body === "OK")
    return {
      updated: true,
      lines: [`${option.host} → ${describeTarget(ipv4, ipv6)}`],
    };
  if (body === "NOCHG") return { updated: false, lines: [] };
  if (body === "KO") throw new Error("DuckDNS 令牌无效（KO）");
  if (body === "ABUSE") throw new Error("DuckDNS 请求过于频繁（ABUSE）");
  throw new Error(`DuckDNS 返回未知状态：${body}`);
}

async function syncCloudflare(
  option: DdnsOption,
  ipv4?: string,
  ipv6?: string,
): Promise<SyncResult> {
  if (!option.zone) throw new Error("Cloudflare DDNS 需要 DDNS_ZONE");
  const headers = {
    Authorization: `Bearer ${option.token}`,
    "Content-Type": "application/json",
  };
  const entries: { type: "A" | "AAAA"; ip: string }[] = [];
  if (ipv4) entries.push({ type: "A", ip: ipv4 });
  if (ipv6) entries.push({ type: "AAAA", ip: ipv6 });
  const changes: string[] = [];
  for (const entry of entries) {
    const listed = await cfRequest(
      `/zones/${option.zone}/dns_records?name=${encodeURIComponent(
        option.host,
      )}&type=${entry.type}`,
      { method: "GET", headers },
    );
    const record = listed?.result?.[0];
    if (record?.content === entry.ip) continue;
    if (record?.id) {
      await cfRequest(`/zones/${option.zone}/dns_records/${record.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          type: entry.type,
          name: option.host,
          content: entry.ip,
          proxied: false,
          ttl: 120,
        }),
      });
    } else {
      await cfRequest(`/zones/${option.zone}/dns_records`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: entry.type,
          name: option.host,
          content: entry.ip,
          proxied: false,
          ttl: 120,
        }),
      });
    }
    changes.push(`${entry.type} ${option.host} → ${entry.ip}`);
  }
  return { updated: changes.length > 0, lines: changes };
}

async function cfRequest(path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    const detail = Array.isArray(data?.errors)
      ? data.errors
          .map((error: any) => error?.message)
          .filter(Boolean)
          .join("；")
      : "";
    throw new Error(`Cloudflare API ${response.status}：${detail || "请求失败"}`);
  }
  return data;
}

function describeTarget(ipv4?: string, ipv6?: string) {
  const parts = [
    ipv4 ? `A=${ipv4}` : "",
    ipv6 ? `AAAA=${ipv6}` : "",
  ].filter(Boolean);
  return parts.join(", ") || "无地址";
}
