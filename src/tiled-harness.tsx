import { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Folder, LoaderCircle, SendHorizontal } from "lucide-react";
import { TiledStage } from "./tiled/TiledStage";
import type { ProjectGroup } from "./projects";
import { ToastStack } from "./ui";
import type {
  Approval,
  Provider,
  SessionSearchMatch,
  ThreadSummary,
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
import "./search-picker.css";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = "dark";

const PROVIDERS: Provider[] = [
  {
    id: "official",
    name: "Official",
    kind: "local-profile",
    color: "#8b5cf6",
    hasApiKey: true,
    enabled: true,
    online: true,
    current: true,
  },
  {
    id: "relay",
    name: "Relay",
    kind: "custom",
    color: "#0ea5e9",
    hasApiKey: true,
    enabled: true,
    online: true,
  },
];

const now = Date.now();
const minutes = (value: number) => now - value * 60_000;

function thread(
  partial: Partial<ThreadSummary> & Pick<ThreadSummary, "id" | "name" | "cwd">,
): ThreadSummary {
  return {
    providerId: "official",
    agentId: "codex",
    model: "gpt-5.3-codex",
    preview: "",
    status: "idle",
    updatedAt: minutes(30),
    ...partial,
  };
}

const INITIAL_THREADS: ThreadSummary[] = [
  thread({
    id: "tiled",
    name: "tiled-mode",
    cwd: "/home/ovalene/Codecks",
    status: "running",
    updatedAt: minutes(0.4),
    preview: "正在生成平铺布局组件 · tsc --noEmit 通过",
  }),
  thread({
    id: "etl",
    name: "nightly-etl",
    cwd: "/home/ovalene/work/data-pipeline",
    agentId: "opencode",
    providerId: "relay",
    status: "running",
    updatedAt: minutes(2),
    preview: "merge 阶段 3/5 · writing partitioned output",
  }),
  thread({
    id: "gateway",
    name: "retry-backoff",
    cwd: "/home/ovalene/work/api-gateway",
    agentId: "claude",
    status: "waiting",
    updatedAt: minutes(4),
    preview: "等待审批 · 证书重生成",
  }),
  thread({
    id: "mobile",
    name: "push-notify",
    cwd: "/home/ovalene/work/mobile-app",
    status: "error",
    updatedAt: minutes(9),
    lastError: "PROVISIONING_PROFILE expired",
    preview: "构建失败：签名证书过期",
  }),
  thread({
    id: "docs",
    name: "i18n-zh",
    cwd: "/home/ovalene/work/docs-site",
    agentId: "claude",
    providerId: "relay",
    status: "idle",
    updatedAt: minutes(120),
    preview: "中文翻译已同步到 87%",
  }),
  thread({
    id: "infra",
    name: "terraform-plan",
    cwd: "/home/ovalene/work/infra",
    agentId: "opencode",
    providerId: "relay",
    status: "idle",
    updatedAt: minutes(45),
    preview: "plan 完成：+3 ~1 -0",
  }),
  thread({
    id: "dotfiles",
    name: "nvim-config",
    cwd: "/home/ovalene/dotfiles",
    status: "idle",
    updatedAt: minutes(300),
    preview: "lazy.nvim 插件已锁定版本",
  }),
];

const PROJECT_META: Record<string, { name: string; pinned?: boolean }> = {
  "/home/ovalene/Codecks": { name: "codex-deck", pinned: true },
  "/home/ovalene/work/data-pipeline": { name: "data-pipeline" },
  "/home/ovalene/work/api-gateway": { name: "api-gateway", pinned: true },
  "/home/ovalene/work/mobile-app": { name: "mobile-app" },
  "/home/ovalene/work/docs-site": { name: "docs-site" },
  "/home/ovalene/work/infra": { name: "infra" },
  "/home/ovalene/dotfiles": { name: "dotfiles" },
};

function groupsFor(threads: ThreadSummary[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const item of threads) {
    const meta = PROJECT_META[item.cwd] || {
      name: item.cwd.split("/").pop() || item.cwd,
    };
    const group =
      map.get(item.cwd) ||
      ({
        key: item.cwd,
        cwd: item.cwd,
        name: meta.name,
        pinned: meta.pinned,
        sessions: [],
        updatedAt: 0,
      } satisfies ProjectGroup);
    group.sessions.push(item);
    group.updatedAt = Math.max(group.updatedAt, item.updatedAt);
    map.set(item.cwd, group);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

interface DemoLine {
  role: "user" | "agent";
  text: string;
}

const HERO_LINES: Record<string, DemoLine[]> = {
  tiled: [
    { role: "user", text: "给网页加一个监控台，活跃会话放在屏幕中间" },
    {
      role: "agent",
      text: "方案：中心 hero 显示聚焦会话，左右卫星栏放其余活跃会话，空闲项目收进底部 dock。列表模式原样保留，顶栏一键切换。",
    },
  ],
  gateway: [
    { role: "user", text: "本地 dev 证书过期了，帮我重建" },
    { role: "agent", text: "需要删除 tmp/certs 并重新生成，等你确认。" },
  ],
};

function Harness() {
  const [threads, setThreads] = useState(INITIAL_THREADS);
  const [approvals, setApprovals] = useState<Approval[]>([
    {
      id: "gateway:approval-1",
      providerId: "official",
      agentId: "claude",
      kind: "command",
      request: {
        method: "exec",
        params: {
          threadId: "gateway",
          command: "rm -rf tmp/certs && ./regen-certs.sh",
        },
      },
      command: "rm -rf tmp/certs && ./regen-certs.sh",
      cwd: "/home/ovalene/work/api-gateway",
    },
  ]);
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(
    () => new Set(["claude:official:gateway", "opencode:relay:infra"]),
  );
  const [focusedKey, setFocusedKey] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "attention" | "unseen"
  >("all");
  const [library, setLibrary] = useState<"active" | "archived">("active");
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [lines, setLines] = useState<Record<string, DemoLine[]>>(HERO_LINES);
  const [draft, setDraft] = useState("");
  const timelineRef = useRef<HTMLDivElement>(null);

  const pushToast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2200,
    );
  };

  const groups = useMemo(() => groupsFor(threads), [threads]);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    const matches = (thread: ThreadSummary) =>
      !value ||
      thread.name.toLowerCase().includes(value) ||
      thread.cwd.toLowerCase().includes(value) ||
      thread.preview.toLowerCase().includes(value);
    const statusOk = (thread: ThreadSummary) => {
      if (statusFilter === "active") return thread.status === "running";
      if (statusFilter === "attention")
        return thread.status === "waiting" || thread.status === "error";
      if (statusFilter === "unseen")
        return unseen.has(
          `${thread.agentId || "codex"}:${thread.providerId}:${thread.id}`,
        );
      return true;
    };
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter(
          (thread) => matches(thread) && statusOk(thread),
        ),
      }))
      .filter((group) => group.sessions.length);
  }, [groups, query, statusFilter, unseen]);

  const focused = threads.find(
    (thread) =>
      `${thread.agentId || "codex"}:${thread.providerId}:${thread.id}` ===
      focusedKey,
  );

  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [focusedKey, lines]);

  const counts = useMemo(
    () => ({
      running: threads.filter((item) => item.status === "running").length,
      waiting: threads.filter((item) => item.status === "waiting").length,
      errors: threads.filter((item) => item.status === "error").length,
      unseen: unseen.size,
    }),
    [threads, unseen],
  );

  const heroLines = focused ? lines[focused.id] || [] : [];

  const hero = focused ? (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-header-row1">
          <div className="chat-title">
            <h2>{focused.name}</h2>
            <p>
              <Folder /> {focused.cwd}
            </p>
          </div>
        </div>
      </header>
      <div className="timeline" ref={timelineRef}>
        {heroLines.map((line, index) => (
          <div className={`message ${line.role}`} key={index}>
            {line.text}
          </div>
        ))}
        {focused.status === "running" && (
          <div className="message agent">
            <LoaderCircle className="spin" size={14} /> 处理中…
          </div>
        )}
        {!heroLines.length && focused.status !== "running" && (
          <div className="message agent">（原型：这里会渲染真实会话内容）</div>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          setDraft("");
          const append = (line: DemoLine) =>
            setLines((current) => ({
              ...current,
              [focused.id]: [...(current[focused.id] || []), line],
            }));
          append({ role: "user", text });
          window.setTimeout(
            () =>
              append({
                role: "agent",
                text: "收到，继续处理中…（原型自动回复）",
              }),
            600,
          );
        }}
      >
        <div className="composer-box">
          <textarea
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`给 ${focused.name} 发消息…`}
          />
        </div>
        <div className="composer-actions">
          <span />
          <button type="submit" className="primary">
            <SendHorizontal size={14} /> 发送
          </button>
        </div>
      </form>
    </main>
  ) : undefined;

  return (
    <div className="tiled-shell">
      <TiledStage
        groups={filtered}
        focused={focused}
        unseenSessions={unseen}
        approvals={approvals}
        providers={PROVIDERS}
        forkCounts={new Map()}
        searchMatches={new Map<string, SessionSearchMatch>()}
        query={query}
        counts={counts}
        statusFilter={statusFilter}
        library={library}
        sessionCount={threads.length}
        archivedCount={0}
        loading={false}
        notificationPermission="default"
        hero={hero}
        dockProjects={groups
          .filter((group) => group.pinned)
          .concat(groups)
          .filter(
            (group, index, list) =>
              list.findIndex((item) => item.key === group.key) === index,
          )}
        onSelect={(thread) => {
          const key = `${thread.agentId || "codex"}:${thread.providerId}:${thread.id}`;
          setFocusedKey(key);
          setUnseen((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }}
        onExitFocus={() => setFocusedKey(undefined)}
        onSwitchToList={() => pushToast("原型演示：正式版这里切回左侧列表布局")}
        onQuery={setQuery}
        onStatusFilter={setStatusFilter}
        onLibrary={setLibrary}
        onNew={() => pushToast("原型演示：新建会话弹窗")}
        onNewInProject={(project) =>
          pushToast(`原型演示：在 ${project.name} 新建会话`)
        }
        onSessionMenu={(thread) => pushToast(`原型演示：${thread.name} 的菜单`)}
        onHistory={(thread) => pushToast(`原型演示：${thread.name} 的历史`)}
        onResolveApproval={(id, body) => {
          setApprovals((current) =>
            current.filter((approval) => approval.id !== id),
          );
          setThreads((current) =>
            current.map((item) =>
              item.id === "gateway"
                ? {
                    ...item,
                    status: body.decision === "decline" ? "idle" : "running",
                    preview:
                      body.decision === "decline"
                        ? "已拒绝 · 等待下一步指令"
                        : "已批准 · 正在重生成证书",
                  }
                : item,
            ),
          );
          pushToast(body.decision === "decline" ? "已拒绝" : "已批准");
        }}
        onTasks={() => pushToast("原型演示：任务中心")}
        onTools={(pathname) =>
          pushToast(`原型演示：打开 ${pathname || "/terminal"}`)
        }
        onProviders={() => pushToast("原型演示：供应商设置")}
        onUsage={() => pushToast("原型演示：用量统计")}
        onAppearance={() => pushToast("原型演示：外观设置")}
        onNotifications={() => pushToast("原型演示：系统提醒")}
      />
      <ToastStack toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
