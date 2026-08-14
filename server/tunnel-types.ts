export interface TunnelController {
  kill(): void;
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
    };

export type TunnelMode = TunnelOption;
export type CloudflareTunnelOption = Extract<TunnelOption, { provider: "cloudflare" }>;
export type CommandTunnelOption = Extract<TunnelOption, { provider: "command" }>;

export type ExposeSpec =
  | { provider: "announce" }
  | { provider: "command" }
  | {
      provider: "cloudflare";
      mode: "quick" | "named" | "share";
      name?: string;
    };
