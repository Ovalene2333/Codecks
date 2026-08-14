import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TunnelController } from "./tunnel-types.js";

export interface ManagedTunnelOptions {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  startingMessage: string;
  missingBinHint: string;
  label: string;
  readyImmediately?: boolean;
  detectReady: (output: string) => string | true | undefined;
  onReady: (origin?: string) => void;
}

export function startManagedTunnel(
  options: ManagedTunnelOptions,
): TunnelController {
  let active: ChildProcessWithoutNullStreams | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;

  const launch = () => {
    if (stopped) return;
    process.stdout.write(options.startingMessage);
    const child = spawn(options.bin, options.args, {
      stdio: "pipe",
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    active = child;
    let output = "";
    let ready = false;
    const markReady = (origin?: string) => {
      if (ready) return;
      ready = true;
      failures = 0;
      options.onReady(origin);
    };
    if (options.readyImmediately) markReady();
    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = `${output}${text}`.slice(-20_000);
      if (ready) return;
      const detected = options.detectReady(output);
      if (detected === undefined) return;
      markReady(typeof detected === "string" ? detected : undefined);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      process.stderr.write(
        `无法启动 ${options.bin}：${error.message}\n${options.missingBinHint}\n`,
      );
    });
    child.once("close", (code) => {
      if (active === child) active = undefined;
      if (stopped) return;
      failures++;
      if (failures > 3) {
        process.stderr.write(
          `${options.label} 连续失败 3 次，最后退出代码 ${code ?? "未知"}。\n${logTail(output)}\n`,
        );
        return;
      }
      const delay = failures === 1 ? 2_000 : 5_000;
      process.stderr.write(
        `${options.label} 已断开，${delay / 1000} 秒后重连（${failures}/3）。\n`,
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

export function logTail(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-12)
    .join("\n");
}
