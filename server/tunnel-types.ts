export interface TunnelController {
  kill(): void;
}

export interface DdnsOption {
  provider: "duckdns" | "cloudflare";
  host: string;
  token: string;
  zone?: string;
  ipv4: "auto" | "none" | string;
  ipv6: "auto" | "none" | string;
  intervalMinutes: number;
}

export type TunnelOption =
  | { provider: "announce"; origin: string }
  | { provider: "cloudflare"; mode: "quick" }
  | { provider: "cloudflare"; mode: "named"; name: string; origin?: string }
  | { provider: "cloudflare"; mode: "share"; hostname: string; tunnelToken: string }
  | {
      provider: "command";
      bin: string;
      argsTemplate: string;
      urlPattern?: string;
      origin?: string;
    }
  | { provider: "ddns"; ddns: DdnsOption };

export type TunnelMode = TunnelOption;
export type CloudflareTunnelOption = Extract<TunnelOption, { provider: "cloudflare" }>;
export type CommandTunnelOption = Extract<TunnelOption, { provider: "command" }>;

export type ExposeSpec =
  | { provider: "announce" }
  | { provider: "command" }
  | { provider: "ddns"; ddns?: "duckdns" | "cloudflare" }
  | {
      provider: "cloudflare";
      mode: "quick" | "named" | "share";
      name?: string;
    };
