import { EventEmitter } from "node:events";
import { OpenCodeAdapter } from "./agents/opencode-adapter.js";
import { OpenCodeV2Adapter } from "./agents/opencode-v2-adapter.js";
import type { AgentAdapter } from "./agents/types.js";
import { probeLocalAgentBin } from "./local-agent-bins.js";

export async function resolveOpenCodeProtocol(
  bin: string,
  probe = probeLocalAgentBin,
): Promise<"v1" | "v2"> {
  const version = await probe(bin);
  if (!version)
    throw new Error(`无法识别 OpenCode 版本（${bin} --version），请检查 CLI`);
  const major = Number(version.split(".")[0]);
  if (major !== 1 && major !== 2)
    throw new Error(
      `OpenCode ${version} 暂不支持，请选择已安装的 OpenCode 1.x 或 2.x`,
    );
  return major === 2 ? "v2" : "v1";
}

type SettingsMethods =
  | "isOnline"
  | "agentCatalog"
  | "cachedConnectedProviders"
  | "probeConnectedProviders"
  | "patchRuntimeConfig";
export type OpenCodeRuntime = AgentAdapter &
  Pick<OpenCodeAdapter, SettingsMethods> & {
    selectExecutable(bin: string): void;
    runtimeProtocol(): "v1" | "v2" | undefined;
  };

/** 单一 OpenCode 入口；注册表与 UI 只接触统一 AgentAdapter 契约。 */
export function createOpenCodeRuntime(options: {
  bin?: string;
  v1: ConstructorParameters<typeof OpenCodeAdapter>[0];
  v2: ConstructorParameters<typeof OpenCodeV2Adapter>[0];
  probe?: typeof probeLocalAgentBin;
  createAdapter?: (protocol: "v1" | "v2", bin: string) => AgentAdapter;
}): OpenCodeRuntime {
  const events = new EventEmitter();
  let bin =
    options.bin || (process.platform === "win32" ? "opencode.cmd" : "opencode");
  let activeBin: string | undefined;
  let startError: string | undefined;
  let activeProtocol: "v1" | "v2" | undefined;
  let active: AgentAdapter = new OpenCodeAdapter(options.v1);
  const forward = (event: unknown) => events.emit("event", event);
  active.on("event", forward);
  let starting: Promise<void> | undefined;
  const controls = {
    id: "opencode",
    on: events.on.bind(events),
    off: events.off.bind(events),
    descriptor() {
      const descriptor = active.descriptor();
      return startError
        ? { ...descriptor, online: false, error: startError }
        : descriptor;
    },
    async reload(): Promise<"process"> {
      active.restart();
      await controls.startAll();
      return "process";
    },
    runtimeProtocol: () => activeProtocol,
    selectExecutable(selected: string) {
      bin =
        selected ||
        (process.platform === "win32" ? "opencode.cmd" : "opencode");
    },
    startAll() {
      if (starting) return starting;
      starting = (async () => {
        const next = await resolveOpenCodeProtocol(bin, options.probe);
        startError = undefined;
        if (next === activeProtocol && activeBin === bin) {
          await active.startAll();
          return;
        }
        active.restart();
        active.off("event", forward);
        active =
          options.createAdapter?.(next, bin) ||
          (next === "v2"
            ? new OpenCodeV2Adapter({ ...options.v2, bin, agentId: "opencode" })
            : new OpenCodeAdapter({ ...options.v1, bin }));
        activeProtocol = next;
        activeBin = bin;
        active.on("event", forward);
        await active.startAll();
      })()
        .catch((error: unknown) => {
          startError = error instanceof Error ? error.message : String(error);
          events.emit("event", {
            type: "agent.status",
            data: controls.descriptor(),
          });
          throw error;
        })
        .finally(() => {
          starting = undefined;
        });
      return starting;
    },
  };
  // 方法必须绑定当前 adapter；切换后不能继续调用旧实例或转发旧事件。
  return new Proxy(controls, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const value = Reflect.get(active, key);
      return typeof value === "function" ? value.bind(active) : value;
    },
  }) as unknown as OpenCodeRuntime;
}
