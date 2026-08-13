export interface CliOptions {
  host: string;
  port: number;
  lan: boolean;
  tunnel?: { mode: "quick" } | { mode: "named"; name: string };
  cloudflaredBin?: string;
  token?: string;
  noToken: boolean;
  help: boolean;
}

export function parseCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let host = env.HOST || "127.0.0.1";
  let port = numberPort(env.PORT || "4174");
  let lan = false;
  let tunnel: CliOptions["tunnel"];
  let cloudflaredBin = env.CODEX_DECK_CLOUDFLARED;
  let token = env.REMOTE_TOKEN;
  let noToken = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--lan") lan = true;
    else if (arg === "--cf-tunnel") {
      lan = true;
      tunnel = { mode: "quick" };
    } else if (arg === "--named-tunnel") {
      const name = argv[++index];
      if (!name || name.startsWith("-"))
        throw new Error(
          "--named-tunnel 需要指定 Cloudflare Tunnel 名称或 UUID",
        );
      lan = true;
      tunnel = { mode: "named", name };
    } else if (arg === "--host") host = requiredValue(argv, ++index, "--host");
    else if (arg === "--port")
      port = numberPort(requiredValue(argv, ++index, "--port"));
    else if (arg === "--token") token = requiredValue(argv, ++index, "--token");
    else if (arg === "--no-token") noToken = true;
    else if (arg === "--cloudflared")
      cloudflaredBin = requiredValue(argv, ++index, "--cloudflared");
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`未知参数：${arg}。使用 --help 查看帮助。`);
  }
  if (lan) host = "0.0.0.0";
  if (noToken && token)
    throw new Error("--no-token 不能与 --token 或 REMOTE_TOKEN 同时使用");
  return { host, port, lan, tunnel, cloudflaredBin, token, noToken, help };
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

  --lan                    监听局域网并打印手机访问地址
  --cf-tunnel              同时开启局域网和临时 trycloudflare.com 隧道
  --named-tunnel <名称>    同时开启局域网和指定的 Cloudflare Named Tunnel
  --host <地址>            自定义监听地址（默认 127.0.0.1）
  --port <端口>            服务端口（默认 4174）
  --token <令牌>           指定访问令牌（也可设置 REMOTE_TOKEN）
  --no-token               关闭 API/WebSocket 鉴权（公开网络慎用）
  --cloudflared <路径>     指定 cloudflared 可执行文件
  -h, --help               显示帮助
`;
