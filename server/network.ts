import os from "node:os";
import { accessUrl } from "./tunnel.js";

export type AddressFamily = "ipv4" | "ipv6";

export function lanAddresses(
  port: number,
  token: string,
  interfaces = os.networkInterfaces(),
  family: AddressFamily = "ipv4",
) {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces))
    for (const item of entries || []) {
      if (item.family !== (family === "ipv6" ? "IPv6" : "IPv4")) continue;
      if (item.internal) continue;
      if (family === "ipv4" && item.address.startsWith("172.17.")) continue;
      if (family === "ipv6" && !isUsableIpv6(item.address)) continue;
      const base =
        family === "ipv6"
          ? `http://[${item.address}]:${port}`
          : `http://${item.address}:${port}`;
      addresses.push(accessUrl(base, token));
    }
  return [...new Set(addresses)];
}

/**
 * A global unicast IPv6 address a browser can open directly: link-local
 * (`fe80::/10`), unique-local (`fc00::/7`) and multicast (`ff00::/8`) need a
 * zone id or are not routed, and loopback/`::` are never useful entries.
 */
export function isUsableIpv6(address: string) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return false;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
  if (lower.startsWith("ff")) return false;
  return true;
}

export function isIpv6Host(host: string) {
  return host.includes(":");
}

export function formatHost(host: string) {
  return isIpv6Host(host) ? `[${host}]` : host;
}
