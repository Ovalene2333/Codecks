import { useState } from "react";
import ReactDOM from "react-dom/client";
import { ProviderModal } from "./overlays/ProviderModal";
import { ConfirmDialog, ToastStack } from "./ui";
import type {
  AgentDescriptor,
  AgentReloadResult,
  Provider,
  RuntimeSnapshot,
  Snapshot,
} from "./types";
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
import "./tiled.css";
import "./monitor.css";
import "./search-picker.css";
import "./kit.css";
import "./settings.css";

/**
 * 设置界面的预览页：没有后端，`/api` 由下面的假实现应答，启用/重载真的会
 * 改状态，所以能直接点着看各种交互。
 *   ?tab=agents|global|codex|claude|opencode   初始标签
 *   ?theme=light                                浅色
 *   ?busy=devin                                 devin 有 2 个会话在运行
 *   ?slow=1                                     接口更慢，便于观察进行中状态
 */
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = theme;
const busyAgent = params.get("busy") || "";
const latency = params.get("slow") ? 2_400 : 700;

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

const PROVIDERS: Provider[] = [
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

const RUNTIME: RuntimeSnapshot = {
  online: true,
  starting: false,
  remoteUrl: "ws://127.0.0.1:37197",
  modelConfig: {},
};

const snapshot = (): Snapshot => ({
  agents: agents.map((item) => ({ ...item })),
  providers: PROVIDERS,
  threads: [],
  approvals: [],
  runtime: RUNTIME,
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
  const initialTab = params.get("tab") || undefined;
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
        <ProviderModal
          providers={state.providers}
          agents={state.agents || []}
          runtime={state.runtime}
          defaultCwd="/home/ovalene/Codecks"
          initialTab={initialTab as any}
          onClose={() => setOpen(false)}
          onSaved={(next) => setState((current) => ({ ...current, ...next }))}
          onToast={toast}
          onConfirm={(spec, run) => setConfirm({ ...spec, run })}
          onConfirmDelete={(provider, run) =>
            setConfirm({
              title: "删除供应商",
              body: (
                <p>
                  确定删除 <b>{provider.name}</b>？
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
                </p>
              ),
              confirmLabel: "保存并重启",
              run,
            })
          }
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
