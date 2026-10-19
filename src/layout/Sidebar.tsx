import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createSidebarDrag } from "./sidebar-drag";
import {
  Activity,
  ArrowDownUp,
  BarChart3,
  BellRing,
  Bot,
  FileText,
  Gauge,
  GitBranch,
  House,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Terminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import { sessionKey } from "../format";
import { Empty, Menu, MenuItem, MenuLabel, MenuSep, Seg, Tip } from "../kit";
import type { DeckNotificationPermission } from "../notifications";
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  normalizeSidebarWidth,
  updateDeckSettings,
  useDeckSettings,
} from "../deck-settings";
import type { ProjectGroup } from "../projects";
import type {
  Provider,
  RuntimeSnapshot,
  SessionSearchMatch,
  SessionWakeState,
  ThreadSummary,
} from "../types";
import { ProjectGroupView } from "../project/ProjectGroup";
import type { SessionBranchRelation } from "../session-branch";
import { UsageChip, type UsageView } from "../usage/UsageChip";

export function Sidebar({
  show,
  operationStatus,
  hiddenOnMobile,
  projectCount,
  sessionCount,
  archivedCount,
  library,
  query,
  searchMatches,
  contentSearchPending,
  contentSearchProgress,
  statusFilter,
  counts,
  projects,
  wakeStates,
  branches,
  selected,
  unseenSessions,
  expandedProjects,
  runtime,
  notificationPermission,
  archiveError,
  loading,
  onClose,
  onNew,
  onRefresh,
  onProviders,
  onUsage,
  onTasks,
  onTools,
  onNotifications,
  onLibrary,
  onQuery,
  onStatusFilter,
  homeActive,
  onHome,
  onToggleProject,
  onMoveProject,
  onMoveSession,
  onResetOrder,
  onSelect,
  onAddInProject,
  onPin,
  onHide,
  onRenameProject,
  onDefaults,
  onArchiveProject,
  onRestoreProject,
  onDeleteProject,
  onHistory,
  onSessionMenu,
  providers,
}: {
  show: boolean;
  operationStatus?: ReactNode;
  hiddenOnMobile: boolean;
  projectCount: number;
  sessionCount: number;
  archivedCount: number;
  library: "active" | "archived";
  query: string;
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  contentSearchPending: boolean;
  contentSearchProgress?: { indexed: number; total: number; building: boolean };
  statusFilter: "all" | "active" | "attention" | "unseen";
  counts: { running: number; waiting: number; errors: number; unseen: number };
  projects: ProjectGroup[];
  /** 会话的 deck-wake 标记（键为 sessionKey）。 */
  wakeStates?: ReadonlyMap<string, SessionWakeState>;
  /** 会话的分支关系（含归档库），用于侧栏标出分支和子分支数。 */
  branches?: ReadonlyMap<string, SessionBranchRelation>;
  selected?: string;
  unseenSessions: ReadonlySet<string>;
  expandedProjects: Set<string>;
  runtime?: RuntimeSnapshot;
  notificationPermission: DeckNotificationPermission;
  archiveError?: string;
  loading?: boolean;
  onClose: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onProviders: () => void;
  onUsage: (view: UsageView) => void;
  onTasks: () => void;
  onTools: (pathname?: string) => void;
  onNotifications: () => void;
  onLibrary: (next: "active" | "archived") => void;
  onQuery: (value: string) => void;
  onStatusFilter: (value: "all" | "active" | "attention" | "unseen") => void;
  /** 当前停在总览首页（没有打开会话）。 */
  homeActive: boolean;
  onHome: () => void;
  onToggleProject: (key: string) => void;
  /** 侧栏拖动：把项目拖到某个项目之前（null = 末尾）。 */
  onMoveProject: (from: string, before: string | null) => void;
  /** 侧栏拖动：把会话拖到同项目某个会话之前（null = 末尾）。 */
  onMoveSession: (projectKey: string, from: string, before: string | null) => void;
  /** 清除所有手动排序，恢复自动排序。 */
  onResetOrder: () => void;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onAddInProject: (project: ProjectGroup) => void;
  onPin: (project: ProjectGroup) => void;
  onHide: (project: ProjectGroup) => void;
  onRenameProject: (project: ProjectGroup) => void;
  onDefaults: (project: ProjectGroup) => void;
  onArchiveProject: (project: ProjectGroup) => void;
  onRestoreProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onHistory: (thread: ThreadSummary) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  providers: Provider[];
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const { hiddenTools, sidebarWidth, sidebarLayout } = useDeckSettings();
  const [reorderMode, setReorderMode] = useState(false);
  // 排序手柄只在「调整顺序」模式下出现；回调变化时重建控制器，避免闭包持有旧列表。
  const drag = useMemo(
    () =>
      createSidebarDrag({
        onProjectMove: onMoveProject,
        onSessionMove: onMoveSession,
      }),
    [onMoveProject, onMoveSession],
  );
  useEffect(() => () => drag.dispose(), [drag]);
  const startProjectDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, key: string) =>
      drag.startDrag(event, { kind: "project", id: key }),
    [drag],
  );
  const startSessionDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, projectKey: string, key: string) =>
      drag.startDrag(event, { kind: "session", id: key, projectKey }),
    [drag],
  );
  const registerProjectRow = useCallback(
    (key: string, node: HTMLElement | null) =>
      node ? drag.registerRow("project", key, node) : undefined,
    [drag],
  );
  const registerSessionRow = useCallback(
    (key: string, node: HTMLElement | null) =>
      node ? drag.registerRow("session", key, node) : undefined,
    [drag],
  );
  /* 拖拽中的临时状态：跟随鼠标时直接改 DOM，不经过 React，避免每次移动都重渲染整个会话列表。 */
  const resizeDrag = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  const commitWidth = (width: number) => {
    const next = normalizeSidebarWidth(width);
    const aside = asideRef.current;
    if (aside) {
      if (next > 0) aside.style.setProperty("--shell-sidebar", `${next}px`);
      else aside.style.removeProperty("--shell-sidebar");
    }
    if (next !== sidebarWidth) updateDeckSettings({ sidebarWidth: next });
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const session = resizeDrag.current;
    if (!session || event.pointerId !== session.pointerId) return;
    resizeDrag.current = null;
    asideRef.current?.classList.remove("is-resizing");
    if (document.body.style.cursor === "col-resize")
      document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 捕获已释放：忽略 */
    }
    if (commit && asideRef.current)
      commitWidth(asideRef.current.getBoundingClientRect().width);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const aside = asideRef.current;
    if (!aside) return;
    event.preventDefault();
    resizeDrag.current = {
      startX: event.clientX,
      startWidth: aside.getBoundingClientRect().width,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    aside.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeDrag.current;
    const aside = asideRef.current;
    if (!session || !aside || event.pointerId !== session.pointerId) return;
    const width = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, Math.round(session.startWidth + (event.clientX - session.startX))),
    );
    aside.style.setProperty("--shell-sidebar", `${width}px`);
  };

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current =
      sidebarWidth > 0
        ? sidebarWidth
        : Math.round(asideRef.current?.getBoundingClientRect().width ?? 288);
    const step = event.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - step;
    else if (event.key === "ArrowRight") next = current + step;
    else if (event.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (event.key === "End") next = SIDEBAR_WIDTH_MAX;
    else if (event.key === "Backspace" || event.key === "Delete") next = 0;
    else return;
    event.preventDefault();
    commitWidth(next);
  };
  const hasWorkspaceTools =
    !hiddenTools.includes("terminal") ||
    !hiddenTools.includes("git") ||
    !hiddenTools.includes("text-editor") ||
    !hiddenTools.includes("commands");
  const searching = Boolean(query.trim());
  const emptyKind = searching
    ? "search"
    : library === "archived"
      ? "archived"
      : "none";
  const matchCount = projects.reduce(
    (sum, project) => sum + project.sessions.length,
    0,
  );
  const activeCount = counts.running + counts.waiting;
  const attentionCount = counts.waiting + counts.errors;
  const showActivity =
    (library === "active" &&
      (activeCount > 0 || attentionCount > 0 || counts.unseen > 0)) ||
    statusFilter !== "all";

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

  return (
    <aside
      ref={asideRef}
      className={`sidebar ${show ? "show" : ""} ${hiddenOnMobile ? "mobile-hidden" : ""}`}
      style={
        sidebarWidth > 0
          ? ({ "--shell-sidebar": `${sidebarWidth}px` } as never)
          : undefined
      }
    >
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={sidebarWidth > 0 ? sidebarWidth : undefined}
        aria-valuetext={sidebarWidth > 0 ? `${sidebarWidth} 像素` : "自动宽度"}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={(event) => endResize(event, true)}
        onPointerCancel={(event) => endResize(event, false)}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => commitWidth(0)}
      />
      <div className="brand">
        <BrandMark className="brand-logo" />
        <div>
          <b>Codex Deck</b>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="sidebar-toolbar">
        <div className="session-search">
          <Search />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索项目、会话与内容"
            aria-label="搜索项目、会话与内容"
          />
          {query && (
            <button className="icon-btn" onClick={() => onQuery("")}>
              <X />
            </button>
          )}
        </div>
        <button type="button" className="new-session-btn" onClick={onNew}>
          <Plus />
          新建
        </button>
      </div>
      <div className="library-bar">
        <Seg
          label="库视图"
          className="library-segment"
          value={library}
          onChange={onLibrary}
          items={[
            {
              value: "active",
              label: (
                <>
                  未归档 <em>{sessionCount}</em>
                </>
              ),
            },
            {
              value: "archived",
              label: (
                <>
                  归档 <em>{archivedCount}</em>
                </>
              ),
            },
          ]}
        />
        <button
          type="button"
          className={`icon-btn reorder-toggle ${reorderMode ? "active" : ""}`}
          onClick={() => setReorderMode((value) => !value)}
          aria-pressed={reorderMode}
          title={reorderMode ? "完成调整顺序" : "拖动调整项目和会话顺序"}
          aria-label={reorderMode ? "完成调整顺序" : "调整顺序"}
        >
          <ArrowDownUp />
        </button>
        {reorderMode &&
          (sidebarLayout.projects.length > 0 ||
            Object.keys(sidebarLayout.sessions).length > 0) && (
            <button
              type="button"
              className="icon-btn"
              onClick={onResetOrder}
              title="恢复自动排序"
              aria-label="恢复自动排序"
            >
              <RotateCcw />
            </button>
          )}
        <button
          className={`icon-btn ${loading ? "refreshing" : ""}`}
          onClick={onRefresh}
          title={loading ? "正在读取项目…" : "刷新"}
        >
          <RefreshCw />
        </button>
        <button
          type="button"
          className={`icon-btn monitor-entry ${homeActive ? "active" : ""}`}
          onClick={onHome}
          title="总览"
          aria-label="回到总览"
          aria-current={homeActive ? "page" : undefined}
        >
          <House />
        </button>
      </div>
      {operationStatus}
      <div className="sidebar-meta">
        <span>
          {loading && !projectCount
            ? "正在读取项目…"
            : loading
              ? `同步中，${projectCount} 个项目`
              : searching
                ? `${matchCount} 个匹配，${projects.length} 个项目${contentSearchPending ? "，检索中" : contentSearchProgress?.building ? `，已索引 ${contentSearchProgress.indexed}/${contentSearchProgress.total}` : ""}`
                : library === "archived"
                  ? `${projects.length} 个归档项目`
                  : `${projectCount} 个项目`}
        </span>
        {showActivity && (
          <div className="watch-strip" role="group" aria-label="会话状态筛选">
            {(activeCount > 0 || statusFilter === "active") && (
              <button
                type="button"
                className={statusFilter === "active" ? "active" : ""}
                aria-pressed={statusFilter === "active"}
                onClick={() =>
                  onStatusFilter(statusFilter === "active" ? "all" : "active")
                }
              >
                <span className="watch-dot running" />
                进行中
                <b>{activeCount}</b>
              </button>
            )}
            {(attentionCount > 0 || statusFilter === "attention") && (
              <button
                type="button"
                className={statusFilter === "attention" ? "active" : ""}
                aria-pressed={statusFilter === "attention"}
                title={`待确认 ${counts.waiting} · 异常 ${counts.errors}`}
                onClick={() =>
                  onStatusFilter(
                    statusFilter === "attention" ? "all" : "attention",
                  )
                }
              >
                <span
                  className={`watch-dot ${counts.errors > 0 && counts.waiting === 0 ? "error" : "waiting"}`}
                />
                需处理
                <b>{attentionCount}</b>
              </button>
            )}
            {(counts.unseen > 0 || statusFilter === "unseen") && (
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
            )}
          </div>
        )}
      </div>
      {archiveError && library === "archived" && (
        <p className="error-banner archive-error">{archiveError}</p>
      )}
      {reorderMode && (
        <p className="sidebar-reorder-hint" role="status">
          拖动项目或会话左上角的手柄调整顺序；该顺序只保存在当前设备。
        </p>
      )}
      <div className={`thread-list ${reorderMode ? "is-reordering" : ""}`}>
        {projects.map((project) => (
          <ProjectGroupView
            key={project.key}
            project={project}
            library={library}
            selected={selected}
            unseenSessions={unseenSessions}
            wakeStates={wakeStates}
            branches={branches}
            collapsed={!searching && !expandedProjects.has(project.key)}
            searchQuery={query}
            searchMatches={searchMatches}
            onToggle={() => onToggleProject(project.key)}
            reorderMode={reorderMode}
            onProjectDragStart={startProjectDrag}
            onSessionDragStart={startSessionDrag}
            registerProjectRow={registerProjectRow}
            registerSessionRow={registerSessionRow}
            onSelect={onSelect}
            onAdd={() => onAddInProject(project)}
            onPin={() => onPin(project)}
            onHide={() => onHide(project)}
            onRename={() => onRenameProject(project)}
            onDefaults={() => onDefaults(project)}
            onArchive={() => onArchiveProject(project)}
            onRestore={() => onRestoreProject(project)}
            onDelete={() => onDeleteProject(project)}
            onHistory={onHistory}
            onSessionMenu={onSessionMenu}
            providers={providers}
          />
        ))}
        {loading && !projects.length && (
          <div
            className="sidebar-skeleton"
            aria-busy="true"
            aria-label="正在读取项目"
          >
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="skeleton-project" />
            ))}
          </div>
        )}
        {!loading && contentSearchPending && !projects.length && (
          <div className="search-pending" role="status">
            <RefreshCw />
            正在检索会话内容
          </div>
        )}
        {!loading && !contentSearchPending && !projects.length && (
          <Empty
            compact
            icon={emptyKind === "search" ? <Search /> : <Bot />}
            title={
              emptyKind === "search"
                ? "没有匹配的会话"
                : emptyKind === "archived"
                  ? "归档箱是空的"
                  : "暂无会话"
            }
            desc={
              emptyKind === "search"
                ? "清除搜索或状态筛选后重试"
                : emptyKind === "archived"
                  ? "归档的会话会出现在这里"
                  : "点「新建」开始一个会话"
            }
          />
        )}
      </div>
      <div className="sidebar-footer">
        <UsageChip runtime={runtime} onOpen={() => onUsage("limits")} />
        <div className="sidebar-footer-actions" role="toolbar" aria-label="侧栏快捷入口">
          <Tip
            content={
              activeCount > 0 ? `任务 · ${activeCount} 项进行中` : "任务"
            }
          >
            <button
              type="button"
              className="sidebar-footer-btn sidebar-task-entry"
              aria-label={
                activeCount > 0 ? `任务（${activeCount} 项进行中）` : "任务"
              }
              onClick={onTasks}
            >
              <Activity />
              {activeCount > 0 ? <b>{activeCount}</b> : null}
            </button>
          </Tip>
          <Menu
            align="start"
            side="top"
            trigger={
              <button
                type="button"
                className="sidebar-footer-btn sidebar-tools-entry"
                aria-label="工具"
                title="工具"
              >
                <Wrench />
              </button>
            }
          >
            {hasWorkspaceTools ? (
              <>
                <MenuLabel>工作区工具</MenuLabel>
                {!hiddenTools.includes("terminal") ? (
                  <MenuItem
                    icon={<Terminal />}
                    onSelect={() => onTools()}
                  >
                    终端
                  </MenuItem>
                ) : null}
                {!hiddenTools.includes("git") ? (
                  <MenuItem
                    icon={<GitBranch />}
                    onSelect={() => onTools("/git")}
                  >
                    Git 管理
                  </MenuItem>
                ) : null}
                {!hiddenTools.includes("text-editor") ? (
                  <MenuItem
                    icon={<FileText />}
                    onSelect={() => onTools("/text-editor")}
                  >
                    文本编辑器
                  </MenuItem>
                ) : null}
                {!hiddenTools.includes("commands") ? (
                  <MenuItem
                    icon={<Zap />}
                    onSelect={() => onTools("/commands")}
                  >
                    快捷指令
                  </MenuItem>
                ) : null}
                <MenuSep />
              </>
            ) : null}
            <MenuLabel>用量与提醒</MenuLabel>
            <MenuItem
              icon={<BarChart3 />}
              onSelect={() => onUsage("stats")}
            >
              用量统计
            </MenuItem>
            <MenuItem
              icon={<Gauge />}
              onSelect={() => onUsage("limits")}
            >
              Codex 额度
            </MenuItem>
            {notificationPermission !== "unsupported" ? (
              <MenuItem
                icon={<BellRing />}
                disabled={notificationPermission === "denied"}
                meta={
                  notificationPermission === "granted"
                    ? "已开启"
                    : notificationPermission === "denied"
                      ? "已阻止"
                      : undefined
                }
                onSelect={() => onNotifications()}
              >
                系统提醒
              </MenuItem>
            ) : null}
          </Menu>
          <Tip content="设置">
            <button
              type="button"
              className="sidebar-footer-btn sidebar-settings-entry"
              aria-label="设置"
              onClick={onProviders}
            >
              <Settings />
            </button>
          </Tip>
        </div>
      </div>
    </aside>
  );
}
