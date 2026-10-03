import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { Sidebar } from "./layout/Sidebar";
import { Welcome } from "./welcome/Welcome";
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

const THREADS: ThreadSummary[] = [
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

function Harness() {
  const groups = useMemo(() => groupsFor(THREADS), []);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.key)),
  );
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const pushToast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2200,
    );
  };
  const counts = {
    running: THREADS.filter((item) => item.status === "running").length,
    waiting: THREADS.filter((item) => item.status === "waiting").length,
    errors: THREADS.filter((item) => item.status === "error").length,
    unseen: 2,
  };
  const noop =
    (message: string) =>
    () =>
      pushToast(message);

  return (
    <div className="app-shell">
      <Sidebar
        show
        hiddenOnMobile={false}
        homeActive
        projectCount={groups.length}
        sessionCount={THREADS.length}
        archivedCount={0}
        library="active"
        query=""
        searchMatches={new Map<string, SessionSearchMatch>()}
        contentSearchPending={false}
        statusFilter="all"
        counts={counts}
        projects={groups}
        selected={undefined}
        unseenSessions={
          new Set(["claude:official:gateway", "opencode:relay:infra"])
        }
        expandedProjects={expanded}
        forkCounts={new Map()}
        runtime={{ online: true } as any}
        notificationPermission="default"
        loading={false}
        onClose={() => {}}
        onNew={noop("新建会话")}
        onRefresh={noop("刷新")}
        onProviders={noop("供应商设置")}
        onUsage={noop("用量")}
        onTasks={noop("任务中心")}
        onTools={noop("工具")}
        onNotifications={noop("通知")}
        onLibrary={noop("切换库")}
        onQuery={noop("搜索")}
        onStatusFilter={noop("筛选")}
        onHome={noop("总览")}
        onToggleProject={(key) =>
          setExpanded((current) => {
            const next = new Set(current);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
          })
        }
        onSelect={noop("选中会话")}
        onAddInProject={noop("项目内新建")}
        onPin={noop("置顶")}
        onHide={noop("隐藏")}
        onRenameProject={noop("重命名")}
        onDefaults={noop("默认设置")}
        onArchiveProject={noop("归档项目")}
        onRestoreProject={noop("恢复项目")}
        onDeleteProject={noop("删除项目")}
        onHistory={noop("历史")}
        onSessionMenu={noop("会话菜单")}
        providers={PROVIDERS}
      />
      <section className="workspace">
        <Welcome
          recent={groups.slice(0, 4)}
          runtime={{ online: true } as any}
          loading={false}
          onNew={noop("新建会话")}
          onOpenProject={noop("打开项目")}
          onUsage={noop("用量")}
        />
      </section>
      <ToastStack toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
