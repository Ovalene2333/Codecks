import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  BellRing,
  Bot,
  Gauge,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import deckLogo from "../assets/logo.svg";
import type { DeckNotificationPermission } from "../notifications";
import type { ProjectGroup } from "../projects";
import type {
  Provider,
  RuntimeSnapshot,
  SessionSearchMatch,
  ThreadSummary,
} from "../types";
import { ProjectGroupView } from "../project/ProjectGroup";
import { UsageChip, type UsageView } from "../usage/UsageChip";

export function Sidebar({
  show,
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
  selected,
  unseenSessions,
  expandedProjects,
  forkCounts,
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
  onToggleProject,
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
  selected?: string;
  unseenSessions: ReadonlySet<string>;
  expandedProjects: Set<string>;
  forkCounts: Map<string, number>;
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
  onTools: () => void;
  onNotifications: () => void;
  onLibrary: (next: "active" | "archived") => void;
  onQuery: (value: string) => void;
  onStatusFilter: (value: "all" | "active" | "attention" | "unseen") => void;
  onToggleProject: (key: string) => void;
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
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const searching = Boolean(query.trim());
  const emptyKind = searching
    ? "search"
    : library === "archived"
      ? "archived"
      : "none";
  const visibleSessions = library === "archived" ? archivedCount : sessionCount;
  const matchCount = projects.reduce(
    (sum, project) => sum + project.sessions.length,
    0,
  );

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
    if (!toolsOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setToolsOpen(false);
        return;
      }
      if (!toolsMenuRef.current?.contains(event.target as Node)) {
        setToolsOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [toolsOpen]);

  return (
    <aside
      className={`sidebar ${show ? "show" : ""} ${hiddenOnMobile ? "mobile-hidden" : ""}`}
    >
      <div className="brand">
        <img className="brand-logo" src={deckLogo} alt="" />
        <div>
          <b>Codex Deck</b>
          <small>REMOTE WORKSPACE</small>
        </div>
        <UsageChip runtime={runtime} onOpen={() => onUsage("limits")} />
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
            aria-label="搜索项目、会话和会话内容"
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
        <div className="library-segment" role="tablist">
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
        <button
          className={`icon-btn ${loading ? "refreshing" : ""}`}
          onClick={onRefresh}
          title={loading ? "正在读取项目…" : "刷新"}
        >
          <RefreshCw />
        </button>
      </div>
      <div className="sidebar-meta">
        <span>
          {loading && !projectCount
            ? "正在读取项目…"
            : loading
              ? `同步中 · ${projectCount} 项目`
              : searching
                ? `${matchCount} 个匹配 · ${projects.length} 个项目${contentSearchPending ? " · 检索中" : contentSearchProgress?.building ? ` · 已索引 ${contentSearchProgress.indexed}/${contentSearchProgress.total}` : ""}`
                : `${projectCount} 项目 · ${visibleSessions} 会话`}
        </span>
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
      </div>
      {archiveError && library === "archived" && (
        <p className="error-banner archive-error">{archiveError}</p>
      )}
      <div className="thread-list">
        {projects.map((project) => (
          <ProjectGroupView
            key={project.key}
            project={project}
            library={library}
            selected={selected}
            unseenSessions={unseenSessions}
            collapsed={!searching && !expandedProjects.has(project.key)}
            forkCounts={forkCounts}
            searchQuery={query}
            searchMatches={searchMatches}
            onToggle={() => onToggleProject(project.key)}
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
          <div className="empty-list">
            {emptyKind === "search" ? <Search /> : <Bot />}
            <p>
              {emptyKind === "search"
                ? "没有匹配的会话"
                : emptyKind === "archived"
                  ? "归档箱是空的"
                  : "还没有现有会话"}
            </p>
            <small>
              {emptyKind === "search"
                ? "清除搜索或状态筛选后重试"
                : emptyKind === "archived"
                  ? "归档的会话会出现在这里"
                  : "点右上角新建，开始一个 Codex 会话"}
            </small>
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <button
            type="button"
            className="sidebar-task-entry"
            onClick={onTasks}
          >
            <Activity />
            <span>任务</span>
            {(counts.running > 0 || counts.waiting > 0) && (
              <b>{counts.running + counts.waiting}</b>
            )}
          </button>
          <div className="sidebar-tools-wrap" ref={toolsMenuRef}>
            <button
              type="button"
              className={toolsOpen ? "active" : ""}
              aria-haspopup="menu"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((open) => !open)}
            >
              <Wrench />
              <span>工具</span>
            </button>
            {toolsOpen && (
              <div className="sidebar-tools-popover" role="menu">
                <div className="sidebar-tools-title">
                  <b>工具</b>
                  <small>工作区与账号</small>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolsOpen(false);
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
                    setToolsOpen(false);
                    onProviders();
                  }}
                >
                  <Settings />
                  <span>
                    <b>供应商设置</b>
                    <small>连接与默认配置</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolsOpen(false);
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
                    setToolsOpen(false);
                    onUsage("limits");
                  }}
                >
                  <Gauge />
                  <span>
                    <b>账号额度</b>
                    <small>Official 额度状态</small>
                  </span>
                </button>
                {notificationPermission !== "unsupported" ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolsOpen(false);
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
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
