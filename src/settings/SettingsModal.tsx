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
  Wrench,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { OpenCodeAgentsSection } from "../overlays/OpenCodeAgentsSection";
import type { Provider, Snapshot } from "../types";
import { Modal, useOverlayHistory } from "../ui";
import { AboutPage } from "./AboutPage";
import { AgentsPanel, ReloadAllButton } from "./AgentsPanel";
import { CodexPage } from "./CodexPage";
import { DataPage } from "./DataPage";
import { DirtyContext } from "./dirty";
import { InterfacePage, type AppearanceControl } from "./InterfacePage";
import { ProvidersPage } from "./ProvidersPage";
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
type AgentDetail = "codex" | "opencode";
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
  { id: "agents", label: "Agent", icon: Bot, desc: "停用的 Agent 不启动，也不出现在新建会话中。修改 opencode.json、acp-agents.json 或 CLI 配置后重载即可生效，无需重启 Deck。" },
  { id: "tools", label: "工具", icon: Wrench, desc: "工具菜单的显示项与打开方式。" },
  { id: "shortcuts", label: "快捷键", icon: Keyboard, desc: "桌面端键盘快捷键一览。" },
  { id: "data", label: "数据", icon: Database, desc: "设置备份、本地缓存与重置。" },
  { id: "about", label: "关于", icon: Info, desc: "版本、运行状态与诊断信息。" },
];
/** 不常用：放在导航最下方的角落，不和日常设置并列。 */
const PROVIDERS_NAV: NavItem = {
  id: "providers",
  label: "供应商",
  icon: Plug,
  desc: "Codex 与 Claude 的模型供应商，通常由 CC Switch 管理。",
};
const ALL_NAV = [...NAV, PROVIDERS_NAV];
const AGENT_DETAILS: Record<AgentDetail, string> = {
  codex: "Codex 为核心 Agent：供应商与共享 Runtime 依附于它。",
  opencode: "主代理与子代理的启用和模型，写入 opencode.json。",
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
  if (tab === "codex" || tab === "opencode")
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

  const navItem = (item: NavItem, minor?: boolean) => {
    const Icon = item.icon;
    const current = active === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={`settings-nav__item${minor ? " is-minor" : ""}${current ? " is-active" : ""}`}
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

  /** 手机的分类列表：同样两组，供应商单独放最下面。 */
  const compactIndex = (
    <div className="settings-index">
      <div className="ui-group">
        {NAV.map((item) => {
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
      <div className="ui-group settings-index__minor">
        <button
          type="button"
          className="settings-index__item"
          onClick={() => go("providers")}
        >
          <Plug aria-hidden />
          <span>供应商</span>
          {dirtyIn("providers") ? <i className="settings-nav__dirty" /> : null}
          <ChevronRight className="settings-index__chevron" aria-hidden />
        </button>
      </div>
    </div>
  );

  const navOf = (id: SettingsPage) =>
    ALL_NAV.find((item) => item.id === id) || NAV[0];
  const agentName = (id: AgentDetail) =>
    agents.find((agent) => agent.id === id)?.name ||
    (id === "codex" ? "Codex" : "OpenCode");

  const head = (key: string): { title: string; desc: string; actions?: ReactNode } => {
    if (key === "agent:codex" || key === "agent:opencode") {
      const id = key.slice(6) as AgentDetail;
      return { title: agentName(id), desc: AGENT_DETAILS[id] };
    }
    const item = navOf(key as SettingsPage);
    return {
      title: item.label,
      desc: item.desc,
      actions:
        key === "agents" ? <ReloadAllButton actions={actions} /> : undefined,
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
              agent.id === "codex" || agent.id === "opencode"
                ? () => go("agents", agent.id as AgentDetail)
                : undefined
            }
          />
        );
      case "agent:codex":
        return (
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
        );
      case "agent:opencode": {
        const opencode = agents.find((agent) => agent.id === "opencode");
        return (
          <OpenCodeAgentsSection
            enabled={opencode?.enabled !== false}
            reloading={actions.pending.opencode === "reload"}
            onReload={() =>
              void actions.reload({
                id: "opencode",
                name: opencode?.name || "OpenCode",
              })
            }
          />
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
            runtime={runtime}
            defaultCwd={defaultCwd}
            onSaved={onSaved}
            onToast={onToast}
            onConfirmDelete={onConfirmDelete}
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
            <button
              type="button"
              className="icon-btn settings-back"
              aria-label="返回"
              title="返回"
              onClick={back}
            >
              <ChevronLeft />
            </button>
          ) : undefined
        }
      >
        <DirtyContext.Provider value={reportDirty}>
          <div className="settings-layout">
            {!compact ? (
              <nav className="settings-nav" aria-label="设置分类">
                {NAV.map((item) => navItem(item))}
                <div className="settings-nav__foot">
                  {navItem(PROVIDERS_NAV, true)}
                </div>
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
