import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
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
 * 用 View Transitions 平滑切换平铺舞台的布局（tile 靠 view-transition-name
 * 在新旧快照间自动 FLIP）。不支持或用户关掉动效时退化为直接执行。
 */
export function runViewTransition(update: () => void) {
  const start = (
    document as Document & {
      startViewTransition?: (cb: () => void) => unknown;
    }
  ).startViewTransition;
  const reduceMotion =
    document.documentElement.dataset.motion === "off" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!start || reduceMotion) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

/** view-transition-name 只接受 custom-ident，会话 key 里的冒号等要清洗。 */
function vtName(thread: ThreadSummary) {
  return `tile-${sessionKey(thread).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** 栏位：活跃中（运行/待确认/新回复）→ 近期（24h 内）→ 不活跃。 */
type LaneId = "active" | "recent" | "idle";
const LANE_RANK: Record<LaneId, number> = { active: 0, recent: 1, idle: 2 };
const RECENT_MS = 24 * 3600_000;
const SETTLE_MS = 10 * 60_000;

const LANE_META: {
  id: LaneId;
  title: string;
  hint: string;
  empty: string;
}[] = [
  {
    id: "active",
    title: "活跃中",
    hint: "运行 · 待确认 · 新回复",
    empty: "没有正在进行的会话",
  },
  { id: "recent", title: "近期", hint: "最近 24 小时", empty: "近期没有会话" },
  { id: "idle", title: "不活跃", hint: "更早的会话", empty: "没有更早的会话" },
];

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
  const laneMemory = useRef(new Map<string, LaneId>());
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

  // 「活跃中」栏内按关注优先级排：待审批 > 待确认 > 异常 > 运行 > 新回复。
  const rankOf = (thread: ThreadSummary) => {
    if (approvalsByThread.get(sessionKey(thread))?.length) return 0;
    if (thread.status === "waiting") return 1;
    if (thread.status === "error") return 2;
    if (isActiveThread(thread)) return 3;
    if (unseenSessions.has(sessionKey(thread))) return 4;
    return 5;
  };

  // 栏位分配带粘性：有新动静立刻晋升到「活跃中」，但只有在会话静默
  // SETTLE_MS 后才允许降栏——避免运行结束/已读瞬间在大区域间跳来跳去。
  const lanes = useMemo(() => {
    const mem = laneMemory.current;
    const nowTs = Date.now();
    const desiredLane = (thread: ThreadSummary): LaneId => {
      if (approvalsByThread.get(sessionKey(thread))?.length) return "active";
      if (thread.status !== "idle" && thread.status !== "offline")
        return "active";
      if (unseenSessions.has(sessionKey(thread))) return "active";
      return nowTs - thread.updatedAt <= RECENT_MS ? "recent" : "idle";
    };
    const assigned = new Map<string, LaneId>();
    for (const thread of sessions) {
      const key = sessionKey(thread);
      const want = desiredLane(thread);
      const had = mem.get(key);
      const settled = nowTs - thread.updatedAt >= SETTLE_MS;
      const lane =
        had && LANE_RANK[want] > LANE_RANK[had] && !settled ? had : want;
      assigned.set(key, lane);
      mem.set(key, lane);
    }
    for (const key of [...mem.keys()]) if (!assigned.has(key)) mem.delete(key);
    const buckets: Record<LaneId, ThreadSummary[]> = {
      active: [],
      recent: [],
      idle: [],
    };
    const byRecency = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const thread of byRecency) {
      const lane = assigned.get(sessionKey(thread)) || "idle";
      buckets[lane].push(thread);
    }
    // 活跃栏内再按关注优先级细分
    buckets.active.sort(
      (a, b) => rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt,
    );
    return buckets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, approvalsByThread, unseenSessions]);

  const focusedKey = focused ? sessionKey(focused) : undefined;
  // 展开后左右栏分工：左栏 = 关注队列（审批/等待/异常/运行/新回复），
  // 右栏 = 上下文（同项目兄弟会话优先，再补最近会话）。聚焦的会话留在
  // 原本队列里并标为当前项，不会因为展开而从边栏消失。
  const attention = lanes.active;
  const attentionKeys = new Set(attention.map((thread) => sessionKey(thread)));
  const focusedProject = focusedKey ? projectOf.get(focusedKey) : undefined;
  const siblings = focusedProject
    ? focusedProject.sessions.filter(
        (thread) => !attentionKeys.has(sessionKey(thread)),
      )
    : [];
  const contextRest = [...lanes.recent, ...lanes.idle].filter(
    (thread) =>
      !attentionKeys.has(sessionKey(thread)) && !siblings.includes(thread),
  );

  const renderTile = (thread: ThreadSummary) => (
    <TileCard
      key={sessionKey(thread)}
      thread={thread}
      current={sessionKey(thread) === focusedKey}
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
        runViewTransition(() =>
          onSelect(
            thread,
            searchMatches.get(`${thread.agentId || "codex"}:${thread.id}`),
          ),
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
          onClick={() => runViewTransition(onExitFocus)}
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
            onClick={() => runViewTransition(onSwitchToList)}
          >
            <List />
            列表
          </button>
          <button
            type="button"
            role="tab"
            className="on"
            aria-selected
            onClick={() => runViewTransition(onExitFocus)}
          >
            <LayoutGrid />
            监控台
          </button>
        </div>
        {focused && (
          <button
            type="button"
            className="icon-btn tiled-overview-btn"
            onClick={() => runViewTransition(onExitFocus)}
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
          <div className="tiled-rail left">
            <header className="rail-head">
              <b>关注</b>
              <em>{attention.length}</em>
            </header>
            <div className="rail-body">
              {attention.map(renderTile)}
              {!attention.length && (
                <p className="rail-empty">没有需要关注的会话</p>
              )}
            </div>
          </div>
          <section
            className={`tile-hero status-${focused.compacting ? "running" : focused.status}`}
          >
            {hero}
          </section>
          <div className="tiled-rail right">
            <header className="rail-head">
              <b>上下文</b>
              <em>{siblings.length + contextRest.length}</em>
            </header>
            <div className="rail-body">
              {siblings.length > 0 && (
                <>
                  <small className="rail-label">同项目</small>
                  {siblings.map(renderTile)}
                </>
              )}
              {contextRest.length > 0 && (
                <>
                  <small className="rail-label">
                    {siblings.length ? "最近" : "最近会话"}
                  </small>
                  {contextRest.slice(0, 14).map(renderTile)}
                </>
              )}
              {!siblings.length && !contextRest.length && (
                <p className="rail-empty">没有其它会话</p>
              )}
            </div>
          </div>
        </main>
      ) : (
        <main className="tiled-overview">
          {sessions.length > 0 &&
            LANE_META.map((lane) => (
              <section className={`tiled-lane lane-${lane.id}`} key={lane.id}>
                <header className="lane-head">
                  <span className="lane-dot" />
                  <b>{lane.title}</b>
                  <small>{lane.hint}</small>
                  <em>{lanes[lane.id].length}</em>
                </header>
                <div className="lane-body">
                  {lanes[lane.id].map(renderTile)}
                  {!lanes[lane.id].length && (
                    <p className="lane-empty">{lane.empty}</p>
                  )}
                </div>
              </section>
            ))}
          {loading && !sessions.length && (
            <>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="tile-card tile-skeleton" />
              ))}
            </>
          )}
          {!loading && !sessions.length && (
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

export function TileCard({
  thread,
  current,
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
  current?: boolean;
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
      className={`tile-card status-${thread.compacting ? "running" : thread.status} ${unseen ? "unseen" : ""} ${approval || searchMatch ? "dense" : ""} ${current ? "current" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={current || undefined}
      style={
        {
          viewTransitionName: vtName(thread),
          viewTransitionClass: "tile",
        } as CSSProperties
      }
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
      <p className="tile-card-preview">
        {preview || <span className="tile-preview-empty">无输出</span>}
      </p>
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
