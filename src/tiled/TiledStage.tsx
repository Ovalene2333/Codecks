import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Activity,
  Archive,
  BarChart3,
  BellRing,
  Check,
  CircleAlert,
  Folder,
  Gauge,
  GitBranch,
  LayoutDashboard,
  LayoutGrid,
  List,
  Lock,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings,
  SunMoon,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import deckLogo from "../assets/logo.svg";
import { agentShortName } from "../agents";
import { distinctPreview, relativeTime, sessionKey } from "../format";
import { isActiveThread, type ProjectGroup } from "../projects";
import { SearchHighlight } from "../project/ProjectGroup";
import { defaultDecisions } from "../session/ApprovalCard";
import { approvalBelongsToThread, approvalPreview } from "../session/approvals";
import type { DeckNotificationPermission } from "../notifications";
import type {
  Approval,
  ApprovalResolveBody,
  Provider,
  SessionSearchMatch,
  ThreadSummary,
} from "../types";
import { Status } from "../ui";
import type { UsageView } from "../usage/UsageChip";

type StatusFilter = "all" | "active" | "attention" | "unseen";

/**
 * 平铺舞台：聚焦会话以 hero 卡居中，其余会话按「需要关注程度」排进两侧
 * 卫星栏；无聚焦时是等大的会话总览网格。底部 dock 放库切换与项目快捷入口。
 */
export function TiledStage({
  groups,
  focused,
  unseenSessions,
  approvals,
  providers,
  forkCounts,
  searchMatches,
  query,
  counts,
  statusFilter,
  library,
  sessionCount,
  archivedCount,
  loading,
  notificationPermission,
  hero,
  dockProjects,
  onSelect,
  onExitFocus,
  onSwitchToList,
  onQuery,
  onStatusFilter,
  onLibrary,
  onNew,
  onNewInProject,
  onSessionMenu,
  onHistory,
  onResolveApproval,
  onTasks,
  onTools,
  onProviders,
  onUsage,
  onAppearance,
  onNotifications,
}: {
  groups: ProjectGroup[];
  focused?: ThreadSummary;
  unseenSessions: ReadonlySet<string>;
  approvals: Approval[];
  providers: Provider[];
  forkCounts: Map<string, number>;
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  query: string;
  counts: { running: number; waiting: number; errors: number; unseen: number };
  statusFilter: StatusFilter;
  library: "active" | "archived";
  sessionCount: number;
  archivedCount: number;
  loading?: boolean;
  notificationPermission: DeckNotificationPermission;
  hero?: ReactNode;
  dockProjects: ProjectGroup[];
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onExitFocus: () => void;
  onSwitchToList: () => void;
  onQuery: (value: string) => void;
  onStatusFilter: (value: StatusFilter) => void;
  onLibrary: (value: "active" | "archived") => void;
  onNew: () => void;
  onNewInProject: (project: ProjectGroup) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  onHistory: (thread: ThreadSummary) => void;
  onResolveApproval: (id: string, body: ApprovalResolveBody) => void;
  onTasks: () => void;
  onTools: (pathname?: string) => void;
  onProviders: () => void;
  onUsage: (view: UsageView) => void;
  onAppearance: () => void;
  onNotifications: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const searching = Boolean(query.trim());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;
      if (
        event.key === "/" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setMenuOpen(false);
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );
  const projectOf = useMemo(() => {
    const map = new Map<string, ProjectGroup>();
    for (const group of groups)
      for (const thread of group.sessions) map.set(sessionKey(thread), group);
    return map;
  }, [groups]);
  const approvalsByThread = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const thread of sessions) {
      const pending = approvals.filter((approval) =>
        approvalBelongsToThread(approval, thread),
      );
      if (pending.length) map.set(sessionKey(thread), pending);
    }
    return map;
  }, [sessions, approvals]);

  const rankOf = (thread: ThreadSummary) => {
    if (approvalsByThread.get(sessionKey(thread))?.length) return 0;
    if (thread.status === "waiting") return 1;
    if (thread.status === "error") return 2;
    if (isActiveThread(thread)) return 3;
    if (unseenSessions.has(sessionKey(thread))) return 4;
    return 5;
  };
  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, approvalsByThread, unseenSessions],
  );

  const focusedKey = focused ? sessionKey(focused) : undefined;
  const satellites = focusedKey
    ? ordered.filter((thread) => sessionKey(thread) !== focusedKey)
    : [];
  const railLeft = satellites.filter((_, index) => index % 2 === 0);
  const railRight = satellites.filter((_, index) => index % 2 === 1);

  const renderTile = (thread: ThreadSummary) => (
    <TileCard
      key={sessionKey(thread)}
      thread={thread}
      project={projectOf.get(sessionKey(thread))}
      unseen={unseenSessions.has(sessionKey(thread))}
      pending={approvalsByThread.get(sessionKey(thread)) || []}
      providers={providers}
      forkCount={forkCounts.get(thread.id) || 0}
      searchMatch={searchMatches.get(
        `${thread.agentId || "codex"}:${thread.id}`,
      )}
      searchQuery={query}
      onSelect={() =>
        onSelect(
          thread,
          searchMatches.get(`${thread.agentId || "codex"}:${thread.id}`),
        )
      }
      onSessionMenu={() => onSessionMenu(thread)}
      onHistory={() => onHistory(thread)}
      onResolveApproval={onResolveApproval}
    />
  );

  return (
    <div className="tiled-view">
      <header className="tiled-topbar">
        <button
          type="button"
          className="tiled-brand"
          onClick={onExitFocus}
          title="会话总览"
        >
          <img className="brand-logo" src={deckLogo} alt="" />
          <b>Codex Deck</b>
        </button>
        <div className="library-segment mode-switch" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={onSwitchToList}
          >
            <List />
            列表
          </button>
          <button
            type="button"
            role="tab"
            className="on"
            aria-selected
            onClick={onExitFocus}
          >
            <LayoutGrid />
            平铺
          </button>
        </div>
        {focused && (
          <button
            type="button"
            className="icon-btn tiled-overview-btn"
            onClick={onExitFocus}
            title="返回全部会话总览"
            aria-label="返回全部会话总览"
          >
            <LayoutDashboard />
          </button>
        )}
        <div className="session-search tiled-search">
          <Search />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索项目、会话与内容"
            aria-label="搜索项目、会话和会话内容"
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onQuery("")}
            >
              <X />
            </button>
          )}
        </div>
        <div className="watch-strip">
          <button
            type="button"
            className={statusFilter === "active" ? "active" : ""}
            aria-pressed={statusFilter === "active"}
            onClick={() =>
              onStatusFilter(statusFilter === "active" ? "all" : "active")
            }
          >
            <span className="watch-dot running" />
            运行
            <b>{counts.running}</b>
          </button>
          <button
            type="button"
            className={statusFilter === "attention" ? "active" : ""}
            aria-pressed={statusFilter === "attention"}
            onClick={() =>
              onStatusFilter(statusFilter === "attention" ? "all" : "attention")
            }
          >
            <span className="watch-dot waiting" />
            待确认
            <b>{counts.waiting}</b>
            {counts.errors > 0 && <em>{counts.errors}</em>}
          </button>
          <button
            type="button"
            className={statusFilter === "unseen" ? "active" : ""}
            aria-pressed={statusFilter === "unseen"}
            onClick={() =>
              onStatusFilter(statusFilter === "unseen" ? "all" : "unseen")
            }
          >
            <span className="watch-dot unseen" />
            新回复
            <b>{counts.unseen}</b>
          </button>
        </div>
        <button type="button" className="new-session-btn" onClick={onNew}>
          <Plus />
          新建
        </button>
        <div className="tiled-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={`icon-btn ${menuOpen ? "active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="更多"
            aria-label="更多操作"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal />
          </button>
          {menuOpen && (
            <div className="sidebar-tools-popover tiled-menu" role="menu">
              <div className="sidebar-tools-title">
                <b>工作台</b>
                <small>任务、工具与设置</small>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onTasks();
                }}
              >
                <Activity />
                <span>
                  <b>任务中心</b>
                  <small>
                    {counts.running + counts.waiting > 0
                      ? `${counts.running + counts.waiting} 个进行中`
                      : "运行中的任务"}
                  </small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onTools();
                }}
              >
                <Terminal />
                <span>
                  <b>终端</b>
                  <small>打开 Web Terminal</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onTools("/git");
                }}
              >
                <GitBranch />
                <span>
                  <b>Git 管理</b>
                  <small>改动、提交与分支</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onUsage("stats");
                }}
              >
                <BarChart3 />
                <span>
                  <b>用量统计</b>
                  <small>按会话与项目查看</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onUsage("limits");
                }}
              >
                <Gauge />
                <span>
                  <b>账号额度</b>
                  <small>Official 额度状态</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onProviders();
                }}
              >
                <Settings />
                <span>
                  <b>供应商设置</b>
                  <small>连接与 Runtime</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onAppearance();
                }}
              >
                <SunMoon />
                <span>
                  <b>外观</b>
                  <small>主题与显示设置</small>
                </span>
              </button>
              {notificationPermission !== "unsupported" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onNotifications();
                  }}
                  disabled={notificationPermission === "denied"}
                >
                  <BellRing />
                  <span>
                    <b>系统提醒</b>
                    <small>
                      {notificationPermission === "granted"
                        ? "已开启"
                        : notificationPermission === "denied"
                          ? "浏览器已阻止"
                          : "审批与任务通知"}
                    </small>
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLibrary(library === "archived" ? "active" : "archived");
                }}
              >
                <Archive />
                <span>
                  <b>{library === "archived" ? "现有会话" : "归档箱"}</b>
                  <small>
                    {library === "archived"
                      ? `${sessionCount} 个会话`
                      : `${archivedCount} 个归档会话`}
                  </small>
                </span>
              </button>
            </div>
          )}
        </div>
      </header>

      {focused ? (
        <main className="tiled-stage">
          <div className="tiled-rail left">{railLeft.map(renderTile)}</div>
          <section
            className={`tile-hero status-${focused.compacting ? "running" : focused.status}`}
          >
            {hero}
          </section>
          <div className="tiled-rail right">{railRight.map(renderTile)}</div>
        </main>
      ) : (
        <main className="tiled-overview">
          {ordered.map(renderTile)}
          {loading && !ordered.length && (
            <>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="tile-card tile-skeleton" />
              ))}
            </>
          )}
          {!loading && !ordered.length && (
            <div className="tiled-empty">
              {searching ? (
                <>
                  <Search />
                  <p>没有匹配的会话</p>
                  <small>清除搜索或状态筛选后重试</small>
                </>
              ) : library === "archived" ? (
                <>
                  <Archive />
                  <p>归档箱是空的</p>
                  <small>归档的会话会出现在这里</small>
                </>
              ) : (
                <>
                  <h1>开始工作</h1>
                  <p>从最近的项目继续，或新建一个会话。</p>
                  <div className="tiled-empty-projects">
                    {dockProjects.map((project) => (
                      <button
                        type="button"
                        key={project.key}
                        onClick={() => onNewInProject(project)}
                      >
                        <Folder />
                        <div>
                          <b>{project.name}</b>
                          <small>{project.cwd}</small>
                        </div>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="recent-create"
                      onClick={onNew}
                    >
                      <Plus />
                      新建会话
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </main>
      )}

      <footer className="tiled-dock">
        <div className="library-segment dock-library" role="tablist">
          <button
            type="button"
            role="tab"
            className={library === "active" ? "on" : ""}
            aria-selected={library === "active"}
            onClick={() => onLibrary("active")}
          >
            现有 <em>{sessionCount}</em>
          </button>
          <button
            type="button"
            role="tab"
            className={library === "archived" ? "on" : ""}
            aria-selected={library === "archived"}
            onClick={() => onLibrary("archived")}
          >
            归档 <em>{archivedCount}</em>
          </button>
        </div>
        {library === "active" && (
          <>
            {dockProjects.map((project) => (
              <button
                type="button"
                className="dock-chip"
                key={project.key}
                title={`在 ${project.cwd} 新建会话`}
                onClick={() => onNewInProject(project)}
              >
                <Folder />
                {project.name}
                {project.pinned && <Pin />}
              </button>
            ))}
            <button type="button" className="dock-chip new" onClick={onNew}>
              <Plus />
              新建会话
            </button>
          </>
        )}
        {library === "archived" && (
          <span className="tiled-dock-empty">归档会话仅可查看</span>
        )}
      </footer>
    </div>
  );
}

function TileCard({
  thread,
  project,
  unseen,
  pending,
  providers,
  forkCount,
  searchMatch,
  searchQuery,
  onSelect,
  onSessionMenu,
  onHistory,
  onResolveApproval,
}: {
  thread: ThreadSummary;
  project?: ProjectGroup;
  unseen: boolean;
  pending: Approval[];
  providers: Provider[];
  forkCount: number;
  searchMatch?: SessionSearchMatch;
  searchQuery: string;
  onSelect: () => void;
  onSessionMenu: () => void;
  onHistory: () => void;
  onResolveApproval: (id: string, body: ApprovalResolveBody) => void;
}) {
  const agentId = thread.agentId || "codex";
  const agentLabel = agentShortName(agentId);
  const provider = providers.find((item) => item.id === thread.providerId);
  const providerLabel =
    provider?.name || (agentId === "codex" ? thread.providerId : "");
  const preview = distinctPreview(thread.name, thread.preview || "");
  const showStatus = thread.status !== "idle" || thread.compacting || unseen;
  const approval = pending[0];
  const decisions = approval ? defaultDecisions(approval) : [];
  const quickResolvable =
    approval &&
    !approval.questions?.length &&
    approval.kind !== "question" &&
    approval.kind !== "permission" &&
    (decisions.includes("accept") || decisions.includes("decline"));

  return (
    <div
      className={`tile-card status-${thread.compacting ? "running" : thread.status} ${unseen ? "unseen" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="tile-card-top">
        {showStatus && (
          <Status
            status={thread.compacting ? "running" : thread.status}
            compact
            unseen={unseen}
            label={thread.compacting ? "正在运行" : undefined}
          />
        )}
        <b className="tile-card-name" title={thread.name}>
          {thread.name}
        </b>
        <button
          type="button"
          className="session-row-more"
          title="会话操作"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSessionMenu();
          }}
        >
          <MoreHorizontal />
        </button>
      </div>
      <div className="tile-card-path" title={thread.cwd}>
        <Folder />
        {project?.name || thread.cwd || "未指定路径"}
      </div>
      {preview && <p className="tile-card-preview">{preview}</p>}
      {searchMatch && (
        <p className="session-search-hit">
          <small>{searchMatch.role === "user" ? "你" : agentLabel}</small>
          <SearchHighlight text={searchMatch.snippet} query={searchQuery} />
        </p>
      )}
      {approval && (
        <div
          className="tile-card-approval"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <CircleAlert />
          <span className="tile-card-approval-text">
            {approvalPreview(approval)}
            {pending.length > 1 ? ` 等 ${pending.length} 项` : ""}
          </span>
          {quickResolvable ? (
            <>
              <button
                type="button"
                className="tile-mini-btn ok"
                onClick={() =>
                  onResolveApproval(approval.id, { decision: "accept" })
                }
              >
                <Check />
                批准
              </button>
              <button
                type="button"
                className="tile-mini-btn"
                onClick={() =>
                  onResolveApproval(approval.id, {
                    decision: decisions.includes("decline")
                      ? "decline"
                      : "cancel",
                  })
                }
              >
                <X />
                拒绝
              </button>
            </>
          ) : (
            <button type="button" className="tile-mini-btn" onClick={onSelect}>
              去处理
            </button>
          )}
        </div>
      )}
      <div className="tile-card-meta">
        <time
          dateTime={
            Number.isFinite(thread.updatedAt)
              ? new Date(thread.updatedAt).toISOString()
              : undefined
          }
        >
          {relativeTime(thread.updatedAt)}
        </time>
        <small
          className={`agent-badge agent-${agentId}`}
          title={`${agentLabel} 任务`}
        >
          {agentLabel}
        </small>
        {providerLabel ? (
          <small
            className="provider-badge session-provider"
            style={
              { "--provider": provider?.color || "#8b6cff" } as CSSProperties
            }
            title={
              thread.model
                ? `${providerLabel} · ${thread.model}`
                : providerLabel
            }
          >
            {providerLabel}
          </small>
        ) : null}
        {thread.controlMode === "history" ? (
          <small
            className="history-badge"
            onClick={(event) => {
              event.stopPropagation();
              onHistory();
            }}
          >
            历史
          </small>
        ) : thread.controlMode === "managed" ? (
          <small className="mode-badge">受管</small>
        ) : null}
        {thread.locked ? (
          <small
            className="lock-badge"
            title="会话正被其它进程占用，仅可查看历史"
          >
            <Lock />
            占用中
          </small>
        ) : null}
        {forkCount > 0 && <small>{forkCount} 分支</small>}
      </div>
    </div>
  );
}
