import { useEffect, useRef } from "react";
import {
  Bot,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import deckLogo from "../assets/logo.svg";
import type { ProjectGroup } from "../projects";
import type { Provider, RuntimeSnapshot, ThreadSummary } from "../types";
import { ProjectGroupView } from "../project/ProjectGroup";
import { UsageChip } from "../usage/UsageChip";

export function Sidebar({
  show,
  hiddenOnMobile,
  projectCount,
  sessionCount,
  archivedCount,
  library,
  query,
  statusFilter,
  counts,
  projects,
  selected,
  expandedProjects,
  forkCounts,
  runtime,
  archiveError,
  loading,
  onClose,
  onNew,
  onRefresh,
  onProviders,
  onUsage,
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
  statusFilter: "all" | "active" | "attention";
  counts: { running: number; waiting: number; errors: number };
  projects: ProjectGroup[];
  selected?: string;
  expandedProjects: Set<string>;
  forkCounts: Map<string, number>;
  runtime?: RuntimeSnapshot;
  archiveError?: string;
  loading?: boolean;
  onClose: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onProviders: () => void;
  onUsage: () => void;
  onLibrary: (next: "active" | "archived") => void;
  onQuery: (value: string) => void;
  onStatusFilter: (value: "all" | "active" | "attention") => void;
  onToggleProject: (key: string) => void;
  onSelect: (thread: ThreadSummary) => void;
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
        <UsageChip runtime={runtime} onOpen={onUsage} />
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
            placeholder="搜索项目、会话、模型"
            aria-label="搜索项目和会话"
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
                ? `${matchCount} 个匹配 · ${projects.length} 个项目`
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
            collapsed={!searching && !expandedProjects.has(project.key)}
            forkCounts={forkCounts}
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
          <div className="sidebar-skeleton" aria-busy="true" aria-label="正在读取项目">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="skeleton-project" />
            ))}
          </div>
        )}
        {!loading && !projects.length && (
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
        <button onClick={onProviders}>
          <Settings />
          供应商设置
        </button>
      </div>
    </aside>
  );
}
