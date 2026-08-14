import { startManagedTunnel } from "./tunnel-process.js";
import type { CommandTunnelOption, TunnelController } from "./tunnel-types.js";
import { accessUrl, normalizePublicOrigin } from "./tunnel-url.js";

export function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

export function expandTunnelArgs(template: string, port: number): string[] {
  const expanded = template
    .replaceAll("{port}", String(port))
    .replaceAll("{url}", `http://127.0.0.1:${port}`);
  return splitArgs(expanded);
}

export function detectPublicOrigin(
  output: string,
  pattern?: string,
): string | undefined {
  if (pattern) {
    const match = output.match(new RegExp(pattern, "i"));
    if (!match) return;
    const raw = (match[1] || match[0]).trim();
    try {
      return normalizePublicOrigin(raw);
    } catch {
      return undefined;
    }
  }

  const matches = output.match(/https:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of matches) {
    try {
      return normalizePublicOrigin(candidate.replace(/[),.;]+$/, ""));
    } catch {
      // skip loopback / invalid URLs and keep scanning
    }
  }
}

export function startCommandTunnel(
  option: CommandTunnelOption,
  port: number,
  token: string,
): TunnelController {
  const args = expandTunnelArgs(option.argsTemplate, port);
  if (!args.length) throw new Error("--tunnel-args 展开后为空");
  const fixed = option.origin
    ? normalizePublicOrigin(option.origin)
    : undefined;

  return startManagedTunnel({
    bin: option.bin,
    args,
    startingMessage: `正在启动隧道命令：${option.bin} ${args.join(" ")}\n`,
    missingBinHint:
      "请确认 --tunnel-bin / CODEX_DECK_TUNNEL_BIN 指向可用的可执行文件。",
    label: "隧道进程",
    readyImmediately: Boolean(fixed),
    detectReady: (output) => {
      if (fixed) return true;
      return detectPublicOrigin(output, option.urlPattern);
    },
    onReady: (origin) => {
      const url = origin || fixed;
      if (!url) return;
      process.stdout.write(`\n公网入口：\n${accessUrl(url, token)}\n\n`);
    },
  });
}
