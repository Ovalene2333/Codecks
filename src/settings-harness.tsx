import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { useAppearance } from "./appearance";
import { initializeDeckSettings } from "./deck-settings";
import {
  requestSystemNotifications,
  type DeckNotificationPermission,
} from "./notifications";
import { SettingsModal, type SettingsTab } from "./settings/SettingsModal";
import { useDeckShortcuts } from "./shortcuts";
import { ConfirmDialog, ToastStack } from "./ui";
import type {
  AgentDescriptor,
  AgentReloadResult,
  DeckPreferences,
  Provider,
  RuntimeSnapshot,
  ServerInfo,
  Snapshot,
} from "./types";
import type { ToolDescriptor } from "../plugin/types";
import "./styles.css";
import "./project-groups.css";
import "./sidebar.css";
import "./chat.css";
import "./approval-inbox.css";
import "./overlays.css";
import "./tokens.css";
import "./polish.css";
import "./appearance.css";
import "./task-tools.css";
import "./deck-ui.css";
import "./monitor.css";
import "./search-picker.css";
import "./kit.css";
import "./settings.css";

/**
 * 设置界面的预览页：没有后端，`/api` 由下面的假实现应答，启用/重载真的会
 * 改状态，所以能直接点着看各种交互。
 *   ?tab=interface|session|agents|codex|opencode|tools|shortcuts|data|about|providers   初始位置
 *   ?theme=light|dark                                  浅色 / 深色
 *   ?busy=devin                                        devin 有 2 个会话在运行
 *   ?slow=1                                            接口更慢，便于观察进行中状态
 *   ?notify=granted|denied|unsupported                 通知权限初值
 *   ?pending=1                                         Runtime 有待应用的供应商配置
 */
const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
const theme = themeParam === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = theme;
const busyAgent = params.get("busy") || "";
const latency = params.get("slow") ? 2_400 : 700;

initializeDeckSettings();

const capabilities = {} as AgentDescriptor["capabilities"];
const agent = (
  id: string,
  name: string,
  extra: Partial<AgentDescriptor> = {},
): AgentDescriptor => ({
  id,
  name,
  available: true,
  online: true,
  starting: false,
  historyStatus: "ready",
  enabled: true,
  toggleable: true,
  capabilities,
  ...extra,
});

const off = (note: string, extra: Partial<AgentDescriptor> = {}) => ({
  enabled: false,
  online: false,
  disabledReason: "default" as const,
  defaultNote: note,
  historyStatus: undefined,
  ...extra,
});

let agents: AgentDescriptor[] = [
  agent("codex", "Codex", { protocol: "native", toggleable: false }),
  agent("claude", "Claude Code", { protocol: "native" }),
  agent("opencode", "OpenCode", { protocol: "native" }),
  agent("devin", "Devin", { protocol: "acp" }),
  agent("kimi", "Kimi", { protocol: "acp", ...off("未检测到 kimi 命令") }),
  agent("goose", "Goose", { protocol: "acp", ...off("未检测到 goose 命令") }),
  agent("copilot", "GitHub Copilot", {
    protocol: "acp",
    ...off("未检测到 copilot 命令"),
  }),
  agent("droid", "Factory Droid", {
    protocol: "acp",
    ...off("未检测到 droid 命令"),
  }),
  agent("claude-acp", "Claude (ACP)", {
    protocol: "acp",
    fallbackFor: "claude",
    standby: true,
  }),
];

let PROVIDERS: Provider[] = [
  {
    id: "official",
    name: "OpenAI Official",
    kind: "local-profile",
    color: "#8b5cf6",
    hasApiKey: true,
    enabled: true,
    online: true,
    current: true,
  },
  {
    id: "cc-relay",
    name: "Relay · gpt-5.3",
    kind: "cc-switch",
    color: "#0ea5e9",
    baseUrl: "https://relay.example.com/v1",
    hasApiKey: true,
    enabled: true,
    online: true,
  },
  {
    id: "cc-claude",
    name: "Claude 中转",
    kind: "cc-switch",
    color: "#f59e0b",
    model: "claude-sonnet-5",
    baseUrl: "https://claude-relay.example.com",
    hasApiKey: true,
    enabled: true,
    online: true,
  },
  {
    id: "custom-1",
    name: "公司网关",
    kind: "custom",
    color: "#10b981",
    baseUrl: "https://gateway.corp.example/v1",
    wireApi: "responses",
    hasApiKey: true,
    enabled: true,
    online: true,
  },
];

const TOOLS: ToolDescriptor[] = [
  {
    id: "terminal",
    name: "Web Terminal",
    description: "通过浏览器连接服务端所在主机的交互式终端",
    icon: "terminal",
    available: true,
  },
  {
    id: "git",
    name: "Git 管理",
    description: "查看改动、管理暂存区与分支，并同步远端仓库",
    icon: "git",
    available: true,
  },
  {
    id: "text-editor",
    name: "文本编辑器",
    description: "浏览宿主机文件系统，查看、编辑、查找并保存文本文件",
    icon: "text-editor",
    available: true,
  },
  {
    id: "commands",
    name: "快捷指令",
    description: "在指定目录一键执行常用指令",
    icon: "commands",
    available: true,
  },
];

const SERVER: ServerInfo = {
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
  node: "v22.12.0",
  platform: "linux",
  wsl: false,
  startedAt: Date.now() - 5 * 3_600_000,
  dataDir: "~/.local/share/codex-deck",
  ccSwitch: "~/.cc-switch/cc-switch.db",
};

let RUNTIME: RuntimeSnapshot = {
  online: true,
  starting: false,
  remoteUrl: "ws://127.0.0.1:37197",
  modelConfig: {},
  ...(params.has("pending") ? { configPending: true } : {}),
};

let PREFERENCES: DeckPreferences = {
  recentDirs: ["/home/ovalene/Codecks", "/home/ovalene/playground"],
  lastAgentId: "codex",
  lastProviderId: "official",
};

const snapshot = (): Snapshot => ({
  agents: agents.map((item) => ({ ...item })),
  providers: [...PROVIDERS],
  threads: [],
  approvals: [],
  preferences: PREFERENCES,
  runtime: RUNTIME,
  tools: TOOLS,
  server: SERVER,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  const method = (init?.method || "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const path = url.pathname;
  if (!path.startsWith("/api/")) return realFetch(input, init);

  if (path === "/api/agents/opencode/config" && method === "PUT") {
    await sleep(latency);
    return json({
      path: body.scope === "project"
        ? `${body.directory || "."}/opencode.json`
        : "~/.config/opencode/opencode.json",
      applied: true,
    });
  }
  if (path === "/api/agents/opencode/config")
    return json({
      online: true,
      global: {
        path: "~/.config/opencode/opencode.json",
        exists: true,
        config: { agent: { plan: { disable: true } } },
      },
      agents: [
        { name: "build", mode: "primary" },
        { name: "plan", mode: "primary" },
        { name: "explore", mode: "subagent" },
        { name: "general", mode: "subagent" },
      ],
    });
  if (path === "/api/agents/opencode/models") return json([]);

  if (path === "/api/preferences" && method === "PUT") {
    await sleep(latency);
    PREFERENCES = { ...PREFERENCES, ...body };
    return json(snapshot());
  }

  const models = path.match(/^\/api\/providers\/([^/]+)\/models$/);
  if (models)
    return json([
      {
        id: "gpt-5.3",
        model: "gpt-5.3",
        displayName: "GPT-5.3",
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
        ],
      },
      {
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
      },
    ]);
  const agentModels = path.match(/^\/api\/agents\/([^/]+)\/models$/);
  if (agentModels) return json([]);

  if (path === "/api/providers" && method === "POST") {
    await sleep(latency);
    PROVIDERS = [
      ...PROVIDERS,
      {
        id: `custom-${Date.now()}`,
        name: body.name,
        kind: "custom",
        color: "#6366f1",
        baseUrl: body.baseUrl,
        model: body.model,
        wireApi: body.wireApi === "chat" ? "chat" : "responses",
        hasApiKey: true,
        enabled: true,
        online: true,
      },
    ];
    return json(snapshot());
  }
  const removeProvider = path.match(/^\/api\/providers\/([^/]+)$/);
  if (removeProvider && method === "DELETE") {
    await sleep(latency);
    PROVIDERS = PROVIDERS.filter(
      (provider) => provider.id !== decodeURIComponent(removeProvider[1]),
    );
    return json(snapshot());
  }

  if (path === "/api/runtime/terminal-command")
    return json({
      command: `codex remote attach ws://127.0.0.1:37197${
        url.searchParams.get("providerId")
          ? ` --provider ${url.searchParams.get("providerId")}`
          : ""
      }${url.searchParams.get("cwd") ? ` --cwd ${url.searchParams.get("cwd")}` : ""}`,
    });
  if (path === "/api/runtime/model-context" && method === "PUT") {
    await sleep(latency);
    RUNTIME = {
      ...RUNTIME,
      modelConfig: {
        modelContextWindow: body.modelContextWindow ?? undefined,
        modelAutoCompactTokenLimit:
          body.modelAutoCompactTokenLimit ?? undefined,
      },
    };
    return json(snapshot());
  }
  if (path === "/api/runtime/apply-provider-config" && method === "POST") {
    await sleep(latency);
    RUNTIME = { ...RUNTIME, configPending: false };
    return json(snapshot());
  }
  if (path === "/api/agents/codex/history/repair" && method === "POST") {
    await sleep(latency);
    return json(snapshot());
  }

  const enabled = path.match(/^\/api\/agents\/([^/]+)\/enabled$/);
  if (enabled && method === "PUT") {
    await sleep(latency);
    const id = decodeURIComponent(enabled[1]);
    if (id === busyAgent && !body.force && body.enabled === false)
      return json({
        applied: false,
        changed: false,
        busyCount: 2,
        snapshot: snapshot(),
      });
    agents = agents.map((item) =>
      item.id !== id
        ? item
        : body.enabled
          ? {
              ...item,
              enabled: true,
              online: id !== "kimi",
              historyStatus: "ready",
              error:
                id === "kimi"
                  ? "spawn kimi ENOENT\n启动命令: kimi acp"
                  : undefined,
              disabledReason: undefined,
              defaultNote: undefined,
            }
          : {
              ...item,
              enabled: false,
              online: false,
              error: undefined,
              historyStatus: undefined,
              disabledReason: "user",
            },
    );
    return json({
      applied: true,
      changed: true,
      busyCount: 0,
      snapshot: snapshot(),
    });
  }

  const reload = path.match(/^\/api\/agents\/([^/]+)\/reload$/);
  if (reload && method === "POST") {
    await sleep(latency);
    const id = decodeURIComponent(reload[1]);
    const busy = id === busyAgent && !body.force;
    const result: AgentReloadResult = {
      id,
      reloaded: !busy,
      busyCount: id === busyAgent ? 2 : 0,
    };
    return json({ result, snapshot: snapshot() });
  }
  if (path === "/api/agents/reload" && method === "POST") {
    await sleep(latency * 1.6);
    const results: AgentReloadResult[] = agents
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        id: item.id,
        reloaded: item.id !== busyAgent,
        busyCount: item.id === busyAgent ? 2 : 0,
      }));
    return json({
      sync: { added: [], removed: [], replaced: [], skippedBusy: [] },
      results,
      snapshot: snapshot(),
    });
  }
  if (path === "/api/runtime/reload" && method === "POST") {
    await sleep(latency);
    return json({
      ...snapshot(),
      restarted: true,
      busyCount: 0,
      ccSwitch: "~/.cc-switch/cc-switch.db",
    });
  }
  return json({ error: `预览页没有实现 ${method} ${path}` }, 404);
};

type ConfirmState = {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  run: () => Promise<void> | void;
};

function Harness() {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<Snapshot>(snapshot());
  const appearance = useAppearance();
  // 与 App 一致：Esc 逐级退出弹层（弹层占位走 history.back）。
  useDeckShortcuts({ goHome: () => setOpen(false) });
  const [notifPermission, setNotifPermission] =
    useState<DeckNotificationPermission>(
      () =>
        (params.get("notify") as DeckNotificationPermission | null) ||
        "default",
    );
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const toast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2_600,
    );
  };
  // ?theme= 显式给出时写进偏好：useAppearance 只认 localStorage，
  // 光改 dataset 会在挂载后被覆盖回去。
  useEffect(() => {
    if (themeParam === "light" || themeParam === "dark")
      appearance.update({ theme: themeParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialTab = (params.get("tab") || undefined) as
    | SettingsTab
    | undefined;
  return (
    <div className="app" style={{ height: "100dvh" }}>
      <section className="workspace">
        <div style={{ padding: 24 }}>
          <button
            type="button"
            className="primary"
            onClick={() => setOpen(true)}
          >
            打开设置
          </button>
        </div>
      </section>
      {open && (
        <SettingsModal
          snapshot={state}
          appearance={appearance}
          notificationPermission={notifPermission}
          onRequestNotifications={() =>
            void requestSystemNotifications().then((next) => {
              setNotifPermission(next);
              toast(
                next === "granted"
                  ? "已开启系统提醒"
                  : next === "unsupported"
                    ? "当前浏览器不支持系统提醒"
                    : "系统提醒未获授权",
              );
            })
          }
          defaultCwd="/home/ovalene/Codecks"
          initialTab={initialTab}
          onClose={() => setOpen(false)}
          onSaved={setState}
          onToast={toast}
          onConfirm={(spec, run) => setConfirm({ ...spec, run })}
          onConfirmDelete={(provider, run) =>
            setConfirm({
              title: "删除供应商",
              body: (
                <p>
                  确定删除 <b>{provider.name}</b>？现有 Session 历史不会删除。
                </p>
              ),
              danger: true,
              confirmLabel: "删除",
              run,
            })
          }
          onConfirmRuntimeRestart={(run) =>
            setConfirm({
              title: "保存上下文设置并重启？",
              body: (
                <p>
                  新设置需要重启共享的 <b>Codex Runtime</b> 才能生效。
                  现有历史不会删除；如果有任务正在运行或等待审批，本次保存会被拒绝。
                </p>
              ),
              confirmLabel: "保存并重启",
              run,
            })
          }
          onOpenTool={(path) => toast(`打开工具 ${path}`)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await confirm.run();
              setConfirm(null);
            } catch (error: any) {
              toast(error?.message || "操作失败");
            }
          }}
        />
      )}
      <ToastStack toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
