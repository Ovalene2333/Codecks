import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Database,
  Info,
  Keyboard,
  MessageSquare,
  Palette,
  Plug,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { Button, Note } from "../kit";
import { OpenCodeAgentsSection } from "../overlays/OpenCodeAgentsSection";
import type { Provider, Snapshot } from "../types";
import { Modal, useOverlayHistory } from "../ui";
import { AboutPage } from "./AboutPage";
import { AgentsPanel, ReloadAllButton } from "./AgentsPanel";
import { CodexBackendSection, LocalBackendSection } from "./BackendSection";
import { CodexPage } from "./CodexPage";
import { DataPage } from "./DataPage";
import { DirtyContext } from "./dirty";
import { InterfacePage, type AppearanceControl } from "./InterfacePage";
import { ProvidersPage, ReloadProvidersButton } from "./ProvidersPage";
import { SessionPage } from "./SessionPage";
import { ShortcutsPage } from "./ShortcutsPage";
import { ToolsPage } from "./ToolsPage";
import { useAgentActions, type ConfirmFn } from "./useAgentActions";

export type SettingsPage =
  | "interface"
  | "session"
  | "agents"
  | "tools"
  | "shortcuts"
  | "data"
  | "about"
  | "providers";
/** 有详情页的 Agent。其余 Agent 只有列表里的启用/重载。 */
type AgentDetail = "codex" | "claude" | "opencode";
/** 打开设置时直达的位置：一级页面，或某个 Agent 的详情。 */
export type SettingsTab = SettingsPage | AgentDetail;

type NavItem = {
  id: SettingsPage;
  label: string;
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  desc: string;
};

const NAV: NavItem[] = [
  { id: "interface", label: "界面", icon: Palette, desc: "主题、动画、消息排版与模板，仅作用于当前设备。" },
  { id: "session", label: "会话", icon: MessageSquare, desc: "新建会话的默认值、输入方式与系统提醒。" },
  { id: "agents", label: "Agent", icon: Bot, desc: "停用的 Agent 不启动，也不出现在新建会话中。" },
  { id: "providers", label: "供应商", icon: Plug, desc: "管理 Codex、Claude、OpenCode 的自定义供应商；CC Switch 为可选只读来源。" },
  { id: "tools", label: "工具", icon: Wrench, desc: "工具菜单的显示项与打开方式。" },
  { id: "shortcuts", label: "快捷键", icon: Keyboard, desc: "桌面端键盘快捷键一览。" },
  { id: "data", label: "数据", icon: Database, desc: "设置备份、本地缓存与重置。" },
  { id: "about", label: "关于", icon: Info, desc: "版本、运行状态与诊断信息。" },
];
/**
 * 分组侧栏（对标 shadcn Settings Page / Vercel SidebarGroup）：
 * 通用 → 模型与 Agent → 系统。供应商不再沉底，跟 Agent 相邻。
 */
const GROUPS: { label: string; items: SettingsPage[] }[] = [
  { label: "通用", items: ["interface", "session", "shortcuts"] },
  { label: "模型与 Agent", items: ["agents", "providers"] },
  { label: "系统", items: ["tools", "data", "about"] },
];
const ALL_NAV = NAV;
const AGENT_DETAILS: Record<AgentDetail, string> = {
  claude: "管理 Claude Code 使用的本机 CLI 版本。",
  codex: "Codex 为核心 Agent：供应商与共享运行时依附于它。",
  opencode: "运行时、代理与权限。",
};

const COMPACT_QUERY = "(max-width: 640px)";

function useCompact() {
  const [compact, setCompact] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(COMPACT_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

/** 二级页在历史栈里占一格：系统返回 / Esc 先退回上一级，而不是关掉整个设置。 */
function HistoryStep({ onBack }: { onBack: () => void }) {
  useOverlayHistory(onBack);
  return null;
}

/** 页面键：一级页面直接用 id，Agent 详情用 `agent:<id>`。 */
const pageKey = (page: SettingsPage, detail: AgentDetail | null) =>
  page === "agents" && detail ? `agent:${detail}` : page;

function resolveInitial(tab?: SettingsTab) {
  if (tab === "codex" || tab === "claude" || tab === "opencode")
    return { page: "agents" as SettingsPage, detail: tab as AgentDetail };
  return { page: (tab || "interface") as SettingsPage, detail: null };
}

export function SettingsModal({
  snapshot,
  appearance,
  notificationPermission,
  defaultCwd,
  initialTab,
  onClose,
  onSaved,
  onToast,
  onConfirm,
  onConfirmDelete,
  onConfirmRuntimeRestart,
  onRequestNotifications,
  onOpenTool,
}: {
  snapshot: Snapshot;
  /** useAppearance() 的返回值。 */
  appearance: AppearanceControl;
  notificationPermission: DeckNotificationPermission;
  defaultCwd?: string;
  initialTab?: SettingsTab;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
  onConfirmDelete: (provider: Provider, run: () => Promise<void>) => void;
  onConfirmRuntimeRestart: (run: () => Promise<void>) => void;
  onRequestNotifications: () => void;
  onOpenTool?: (path: string) => void;
}) {
  const compact = useCompact();
  const initial = resolveInitial(initialTab);
  // 手机：没指定入口时先显示分类列表（page=null），点进去才是具体页面。
  const [page, setPage] = useState<SettingsPage | null>(() =>
    compact && !initialTab ? null : initial.page,
  );
  const [detail, setDetail] = useState<AgentDetail | null>(initial.detail);
  const [visited, setVisited] = useState<Set<string>>(
    () => new Set(page ? [pageKey(page, detail)] : []),
  );
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  /**
   * OpenCode 的供应商/权限/代理写入返回 needsReload：全局提示条提醒
   * "有配置在等生效"，并提供跳到 Agent→OpenCode 服务页重载的捷径。
   */
  const [needsReload, setNeedsReload] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const actions = useAgentActions({ onSaved, onToast, onConfirm });
  const agents = snapshot.agents || [];
  const providers = snapshot.providers;
  const runtime = snapshot.runtime;

  // 桌面没有「分类列表」这一层：page 为空时落到第一页。
  const active: SettingsPage | null = page ?? (compact ? null : "interface");
  const activeKey = active ? pageKey(active, detail) : null;

  const reportDirty = useCallback((key: string, value: boolean) => {
    setDirty((current) =>
      Boolean(current[key]) === value
        ? current
        : { ...current, [key]: value },
    );
  }, []);
  const dirtyIn = (prefix: string) =>
    Object.entries(dirty).some(
      ([key, value]) => value && key.startsWith(`${prefix}:`),
    );
  const anyDirty = Object.values(dirty).some(Boolean);

  const go = (next: SettingsPage | null, nextDetail: AgentDetail | null = null) => {
    setPage(next);
    setDetail(nextDetail);
    if (next)
      setVisited((current) => {
        const key = pageKey(next, nextDetail);
        return current.has(key) ? current : new Set([...current, key]);
      });
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const back = () => {
    if (detail) go(active, null);
    else go(null);
  };

  const requestClose = () => {
    if (!anyDirty) {
      onClose();
      return;
    }
    onConfirm(
      {
        title: "放弃未保存的修改？",
        body: <p>存在尚未保存的修改，关闭设置后将丢失。</p>,
        confirmLabel: "放弃并关闭",
        danger: true,
      },
      () => onClose(),
    );
    return false;
  };

  const navItem = (item: NavItem) => {
    const Icon = item.icon;
    const current = active === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={`settings-nav__item${current ? " is-active" : ""}`}
        aria-current={current ? "page" : undefined}
        onClick={() => go(item.id)}
      >
        <Icon aria-hidden />
        <span>{item.label}</span>
        {dirtyIn(item.id) ? (
          <i className="settings-nav__dirty" title="有未保存的修改" />
        ) : null}
      </button>
    );
  };

  /** 手机的分类列表：与桌面同构的三个分组。 */
  const compactIndex = (
    <div className="settings-index">
      {GROUPS.map((group) => (
        <div key={group.label} className="ui-group">
          {group.items.map((id) => {
            const item = NAV.find((entry) => entry.id === id)!;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="settings-index__item"
                onClick={() => go(item.id)}
              >
                <Icon aria-hidden />
                <span>{item.label}</span>
                {dirtyIn(item.id) ? <i className="settings-nav__dirty" /> : null}
                <ChevronRight className="settings-index__chevron" aria-hidden />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  const navOf = (id: SettingsPage) =>
    ALL_NAV.find((item) => item.id === id) || NAV[0];
  const agentName = (id: AgentDetail) =>
    agents.find((agent) => agent.id === id)?.name ||
    (id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : "OpenCode");

  const head = (key: string): { title: string; desc: string; actions?: ReactNode } => {
    if (key === "agent:codex" || key === "agent:claude" || key === "agent:opencode") {
      const id = key.slice(6) as AgentDetail;
      return { title: agentName(id), desc: AGENT_DETAILS[id] };
    }
    const item = navOf(key as SettingsPage);
    return {
      title: item.label,
      desc: item.desc,
      actions:
        key === "agents" ? (
          <ReloadAllButton actions={actions} />
        ) : key === "providers" ? (
          <ReloadProvidersButton onSaved={onSaved} onToast={onToast} />
        ) : undefined,
    };
  };

  const content = (key: string): ReactNode => {
    switch (key) {
      case "interface":
        return <InterfacePage appearance={appearance} />;
      case "session":
        return (
          <SessionPage
            agents={agents}
            providers={providers}
            preferences={snapshot.preferences}
            notificationPermission={notificationPermission}
            onRequestNotifications={onRequestNotifications}
            onSaved={onSaved}
            onToast={onToast}
          />
        );
      case "agents":
        return (
          <AgentsPanel
            agents={agents}
            actions={actions}
            onOpen={(agent) =>
              agent.id === "codex" || agent.id === "claude" || agent.id === "opencode"
                ? () => go("agents", agent.id as AgentDetail)
                : undefined
            }
          />
        );
      case "agent:claude":
        return <LocalBackendSection agent="claude" onSaved={onSaved} onToast={onToast} />;
      case "agent:codex":
        return (
          <>
            <CodexBackendSection runtime={runtime} onSaved={onSaved} onToast={onToast} />
            <CodexPage
              agent={agents.find((agent) => agent.id === "codex")}
              runtime={runtime}
              providers={providers}
              defaultCwd={defaultCwd}
              onOpenProviders={() => go("providers")}
              onSaved={onSaved}
              onToast={onToast}
              onConfirmRuntimeRestart={onConfirmRuntimeRestart}
            />
          </>
        );
      case "agent:opencode": {
        const opencode = agents.find((agent) => agent.id === "opencode");
        return (
          <>
            <LocalBackendSection
              agent="opencode"
              onSaved={onSaved}
              onToast={onToast}
              // 未换版本时「应用并重启」退化为重启当前：与换版本重启共用一个按钮。
              onRestart={async () => {
                await actions.restart({
                  id: "opencode",
                  name: opencode?.name || "OpenCode",
                });
                setNeedsReload(false);
              }}
            />
            <OpenCodeAgentsSection
              enabled={opencode?.enabled !== false}
              onToast={onToast}
              onNeedsReload={() => setNeedsReload(true)}
              onOpenProviders={() => go("providers")}
            />
          </>
        );
      }
      case "tools":
        return (
          <ToolsPage
            tools={snapshot.tools}
            mobile={compact}
            onOpenTool={onOpenTool}
          />
        );
      case "shortcuts":
        return <ShortcutsPage />;
      case "data":
        return (
          <DataPage
            snapshot={snapshot}
            preferences={snapshot.preferences}
            appearance={appearance}
            onSaved={onSaved}
            onToast={onToast}
            onConfirm={onConfirm}
          />
        );
      case "about":
        return (
          <AboutPage
            snapshot={snapshot}
            notificationPermission={notificationPermission}
            onToast={onToast}
          />
        );
      case "providers":
        return (
          <ProvidersPage
            providers={providers}
            claudeProfiles={snapshot.agentProfiles?.filter((profile) => profile.agentId === "claude")}
            ccSwitch={snapshot.server?.ccSwitch}
            runtime={runtime}
            defaultCwd={defaultCwd}
            onSaved={onSaved}
            onToast={onToast}
            onConfirmDelete={onConfirmDelete}
            onNeedsReload={() => setNeedsReload(true)}
          />
        );
      default:
        return null;
    }
  };

  const title =
    compact && activeKey ? head(activeKey).title : "设置";
  const canGoBack = compact ? Boolean(active) : false;

  return (
    <>
      <Modal
        title={title}
        className="ui-panel settings-modal"
        onClose={requestClose}
        leading={
          canGoBack ? (
            <Button
              variant="ghost"
              iconOnly
              className="settings-back"
              aria-label="返回"
              title="返回"
              onClick={back}
            >
              <ChevronLeft />
            </Button>
          ) : undefined
        }
      >
        <DirtyContext.Provider value={reportDirty}>
          <div className="settings-layout">
            {!compact ? (
              <nav className="settings-nav" aria-label="设置分类">
                {GROUPS.map((group) => (
                  <div key={group.label} className="settings-nav__group">
                    <p className="settings-nav__label">{group.label}</p>
                    {group.items.map((id) =>
                      navItem(NAV.find((entry) => entry.id === id)!),
                    )}
                  </div>
                ))}
              </nav>
            ) : null}
            <div className="ui-panel__body settings-body" ref={bodyRef}>
              {compact && !active ? compactIndex : null}
              {[...visited].map((key) => {
                const info = head(key);
                const shown = key === activeKey;
                const isDetail = key.startsWith("agent:");
                return (
                  <div
                    key={key}
                    className="settings-page"
                    hidden={!shown}
                    role="region"
                    aria-label={info.title}
                  >
                    <header className="settings-page__head">
                      {isDetail && !compact ? (
                        <button
                          type="button"
                          className="settings-crumb"
                          onClick={back}
                        >
                          <ChevronLeft aria-hidden />
                          Agent
                        </button>
                      ) : null}
                      <div className="settings-page__title">
                        <div>
                          <h3>{info.title}</h3>
                          <p>{info.desc}</p>
                        </div>
                        {info.actions ? (
                          <div className="settings-page__actions">
                            {info.actions}
                          </div>
                        ) : null}
                      </div>
                    </header>
                    {needsReload && (
                      <Note
                        tone="warn"
                        icon={<RefreshCw />}
                        title="OpenCode 有配置等待生效"
                        action={
                          <Button
                            size="sm"
                            variant="primary"
                            title="打开 OpenCode 服务页重载"
                            onClick={() => go("agents", "opencode")}
                          >
                            去重载
                          </Button>
                        }
                      >
                        供应商、权限或代理的改动需要重载 OpenCode 才生效。
                      </Note>
                    )}
                    {content(key)}
                  </div>
                );
              })}
            </div>
          </div>
        </DirtyContext.Provider>
      </Modal>
      {/* 放在 Modal 之后：effect 按兄弟顺序执行，先压设置本身、再压二级页。 */}
      {compact && page ? <HistoryStep onBack={() => go(null)} /> : null}
      {detail ? (
        <HistoryStep onBack={() => go(page ?? "agents", null)} />
      ) : null}
    </>
  );
}
