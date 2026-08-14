import {
  normalizePublicOrigin,
  parseExposeSpec,
  type TunnelOption,
} from "./tunnel.js";

export type { TunnelOption };

export interface CliOptions {
  host: string;
  port: number;
  lan: boolean;
  tunnel?: TunnelOption;
  cloudflaredBin?: string;
  token?: string;
  noToken: boolean;
  wsl: boolean;
  help: boolean;
}

export function parseCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let host = env.HOST || "127.0.0.1";
  let port = numberPort(env.PORT || "4174");
  let lan = false;
  let exposeRaw = env.CODEX_DECK_EXPOSE?.trim() || "";
  let publicOrigin =
    env.CODEX_DECK_PUBLIC_ORIGIN?.trim() || env.PUBLIC_ORIGIN?.trim() || "";
  let share = false;
  let shareHost = "";
  let tunnelToken = "";
  let namedName = "";
  let quick = false;
  let cloudflaredBin = env.CODEX_DECK_CLOUDFLARED;
  let tunnelBin = env.CODEX_DECK_TUNNEL_BIN?.trim() || "";
  let tunnelArgs = env.CODEX_DECK_TUNNEL_ARGS?.trim() || "";
  let tunnelUrlPattern = env.CODEX_DECK_TUNNEL_URL_PATTERN?.trim() || "";
  let token = env.REMOTE_TOKEN;
  let noToken = false;
  let wsl = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--lan") lan = true;
    else if (arg === "--cf-tunnel" || arg === "--share-once") {
      lan = true;
      quick = true;
    } else if (arg === "--share") {
      lan = true;
      share = true;
    } else if (arg === "--share-host")
      shareHost = requiredValue(argv, ++index, "--share-host");
    else if (arg === "--tunnel-token")
      tunnelToken = requiredValue(argv, ++index, "--tunnel-token");
    else if (arg === "--named-tunnel") {
      const name = argv[++index];
      if (!name || name.startsWith("-"))
        throw new Error(
          "--named-tunnel 需要指定 Cloudflare Tunnel 名称或 UUID",
        );
      lan = true;
      namedName = name;
    } else if (arg === "--expose")
      exposeRaw = requiredValue(argv, ++index, "--expose");
    else if (arg === "--public-origin")
      publicOrigin = requiredValue(argv, ++index, "--public-origin");
    else if (arg === "--tunnel-bin")
      tunnelBin = requiredValue(argv, ++index, "--tunnel-bin");
    else if (arg === "--tunnel-args")
      tunnelArgs = requiredValue(argv, ++index, "--tunnel-args");
    else if (arg === "--tunnel-url-pattern")
      tunnelUrlPattern = requiredValue(argv, ++index, "--tunnel-url-pattern");
    else if (arg === "--host") host = requiredValue(argv, ++index, "--host");
    else if (arg === "--port")
      port = numberPort(requiredValue(argv, ++index, "--port"));
    else if (arg === "--token") token = requiredValue(argv, ++index, "--token");
    else if (arg === "--no-token") noToken = true;
    else if (arg === "--wsl") wsl = true;
    else if (arg === "--cloudflared")
      cloudflaredBin = requiredValue(argv, ++index, "--cloudflared");
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`未知参数：${arg}。使用 --help 查看帮助。`);
  }

  const tunnel = resolveTunnelOption({
    exposeRaw,
    quick,
    share,
    namedName,
    shareHost,
    tunnelToken,
    publicOrigin,
    tunnelBin,
    tunnelArgs,
    tunnelUrlPattern,
    env,
  });
  if (
    tunnel &&
    (tunnel.provider === "cloudflare" || tunnel.provider === "command")
  )
    lan = true;
  if (lan) host = "0.0.0.0";
  if (noToken && token)
    throw new Error("--no-token 不能与 --token 或 REMOTE_TOKEN 同时使用");
  return { host, port, lan, tunnel, cloudflaredBin, token, noToken, wsl, help };
}

function resolveTunnelOption(input: {
  exposeRaw: string;
  quick: boolean;
  share: boolean;
  namedName: string;
  shareHost: string;
  tunnelToken: string;
  publicOrigin: string;
  tunnelBin: string;
  tunnelArgs: string;
  tunnelUrlPattern: string;
  env: NodeJS.ProcessEnv;
}): TunnelOption | undefined {
  const expose = input.exposeRaw ? parseExposeSpec(input.exposeRaw) : undefined;
  const legacyKinds = [
    input.quick ? "cloudflare-quick" : "",
    input.share ? "cloudflare-share" : "",
    input.namedName ? "cloudflare-named" : "",
  ].filter(Boolean);
  if (legacyKinds.length > 1) {
    throw new Error(
      "请只选 --share（固定域名）或 --cf-tunnel / --share-once（临时域名）之一",
    );
  }

  const legacyKind = legacyKinds[0] as
    | "cloudflare-quick"
    | "cloudflare-share"
    | "cloudflare-named"
    | undefined;
  const exposeKind = expose
    ? expose.provider === "cloudflare"
      ? (`cloudflare-${expose.mode}` as const)
      : expose.provider
    : undefined;

  if (exposeKind && legacyKind && exposeKind !== legacyKind) {
    throw new Error(
      `--expose ${input.exposeRaw} 与 --cf-tunnel / --share / --named-tunnel 冲突，请只选一种暴露方式`,
    );
  }

  const kind =
    exposeKind || legacyKind || (input.publicOrigin ? "announce" : undefined);
  if (!kind) return undefined;

  if (kind === "announce") {
    const origin = input.publicOrigin.trim();
    if (!origin)
      throw new Error("announce 需要 --public-origin 或 CODEX_DECK_PUBLIC_ORIGIN");
    normalizePublicOrigin(origin);
    return { provider: "announce", origin };
  }

  if (kind === "command") {
    if (!input.tunnelBin) {
      throw new Error(
        "command 暴露方式必须设置 --tunnel-bin 或 CODEX_DECK_TUNNEL_BIN",
      );
    }
    if (!input.tunnelArgs) {
      throw new Error(
        "command 暴露方式必须设置 --tunnel-args 或 CODEX_DECK_TUNNEL_ARGS",
      );
    }
    if (input.tunnelUrlPattern) {
      try {
        new RegExp(input.tunnelUrlPattern, "i");
      } catch {
        throw new Error(
          `--tunnel-url-pattern 不是有效正则：${input.tunnelUrlPattern}`,
        );
      }
    }
    if (input.publicOrigin) normalizePublicOrigin(input.publicOrigin);
    return {
      provider: "command",
      bin: input.tunnelBin,
      argsTemplate: input.tunnelArgs,
      urlPattern: input.tunnelUrlPattern || undefined,
      origin: input.publicOrigin || undefined,
    };
  }

  if (kind === "cloudflare-quick") {
    return { provider: "cloudflare", mode: "quick" };
  }

  if (kind === "cloudflare-named") {
    const name =
      (expose && expose.provider === "cloudflare" && expose.name) ||
      input.namedName;
    if (!name) {
      throw new Error(
        "cloudflare:named 需要指定 Tunnel 名称或 UUID（--expose cloudflare:named=<名称> 或 --named-tunnel）",
      );
    }
    const origin = input.publicOrigin || input.shareHost || undefined;
    if (origin) normalizePublicOrigin(origin);
    return origin
      ? { provider: "cloudflare", mode: "named", name, origin }
      : { provider: "cloudflare", mode: "named", name };
  }

  const hostname =
    input.shareHost.trim() ||
    input.publicOrigin.trim() ||
    input.env.CF_TUNNEL_HOSTNAME?.trim() ||
    "";
  const connector =
    input.tunnelToken.trim() || input.env.CF_TUNNEL_TOKEN?.trim() || "";
  if (!hostname || !connector) {
    const missing = [
      !connector ? "CF_TUNNEL_TOKEN / --tunnel-token" : "",
      !hostname ? "CF_TUNNEL_HOSTNAME / --share-host / --public-origin" : "",
    ].filter(Boolean);
    throw new Error(
      `固定域名分享（--share / --expose cloudflare:share）必须同时设置 ${missing.join(" 和 ")}；若只要一次性临时域名，请用 --cf-tunnel 或 --expose cloudflare:quick。`,
    );
  }
  normalizePublicOrigin(hostname);
  return {
    provider: "cloudflare",
    mode: "share",
    hostname,
    tunnelToken: connector,
  };
}

function requiredValue(argv: string[], index: number, option: string) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} 缺少值`);
  return value;
}

function numberPort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`端口无效：${value}`);
  return port;
}

export const CLI_HELP = `Codex Deck

用法：npm start -- [选项]

监听
  --lan                    监听局域网并打印手机访问地址
  --host <地址>            自定义监听地址（默认 127.0.0.1）
  --port <端口>            服务端口（默认 4174）

暴露（把本地端口接到外面；与监听、鉴权独立）
  --expose <供应商>        announce | cloudflare[:quick|named|share] | command
  --public-origin <url>    已有反代或固定域名时的 https 入口
  --tunnel-bin <路径>      command 供应商的可执行文件
  --tunnel-args <模板>     command 参数模板，可用 {port}、{url}
  --tunnel-url-pattern     从命令输出提取公网 URL 的正则

Cloudflare 兼容入口
  --share                  等同 --expose cloudflare:share
  --share-host <域名>      覆盖固定公网域名（默认 CF_TUNNEL_HOSTNAME）
  --tunnel-token <token>   Cloudflare connector token（也可用 CF_TUNNEL_TOKEN）
  --cf-tunnel              等同 --expose cloudflare:quick
  --share-once             同 --cf-tunnel
  --named-tunnel <名称>    等同 --expose cloudflare:named=<名称>
  --cloudflared <路径>     指定 cloudflared 可执行文件

鉴权与运行时
  --token <令牌>           指定访问令牌（也可设置 REMOTE_TOKEN）
  --no-token               关闭 API/WebSocket 鉴权（公开网络慎用）
  --wsl                    Windows 上在 WSL 中启动 Codex runtime
  -h, --help               显示帮助
`;
