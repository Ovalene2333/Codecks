import { useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Lock,
  MoreHorizontal,
  Pin,
  Plus,
} from "lucide-react";
import { agentShortName } from "../agents";
import { previewSessions } from "../projects";
import type { ProjectGroup as ProjectGroupData } from "../projects";
import type { Provider, SessionSearchMatch, ThreadSummary } from "../types";
import { Status } from "../ui";
import { relativeTime, sessionKey } from "../format";
import { ProjectMenu } from "./ProjectMenu";

export function ProjectGroupView({
  project,
  library,
  selected,
  unseenSessions,
  collapsed,
  forkCounts,
  searchQuery,
  searchMatches,
  onToggle,
  onSelect,
  onAdd,
  onPin,
  onHide,
  onRename,
  onDefaults,
  onArchive,
  onRestore,
  onDelete,
  onHistory,
  onSessionMenu,
  providers,
}: {
  project: ProjectGroupData;
  library: "active" | "archived";
  selected?: string;
  unseenSessions: ReadonlySet<string>;
  collapsed: boolean;
  forkCounts: Map<string, number>;
  searchQuery: string;
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  onToggle: () => void;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onAdd: () => void;
  onPin: () => void;
  onHide: () => void;
  onRename: () => void;
  onDefaults: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onHistory: (thread: ThreadSummary) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  providers: Provider[];
}) {
  const [menu, setMenu] = useState(false);
  const visible = previewSessions(project.sessions, !collapsed, {
    isPinned: (thread) => {
      const key = sessionKey(thread);
      return key === selected || unseenSessions.has(key);
    },
  });
  const hiddenCount = project.sessions.length - visible.length;
  const providerById = new Map(
    providers.map((item) => [item.id, item] as const),
  );
  const providerCounts = new Map<string, Map<string, number>>();
  for (const thread of project.sessions) {
    const agentId = thread.agentId || "codex";
    const counts = providerCounts.get(agentId) || new Map<string, number>();
    counts.set(thread.providerId, (counts.get(thread.providerId) || 0) + 1);
    providerCounts.set(agentId, counts);
  }
  const commonProviderByAgent = new Map(
    [...providerCounts].map(([agentId, counts]) => [
      agentId,
      [...counts].sort((a, b) => b[1] - a[1])[0]?.[0],
    ]),
  );
  return (
    <div className={`project-group ${project.pinned ? "pinned" : ""}`}>
      <div className="project-heading">
        <button
          className="project-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "展开该项目" : "折叠该项目"}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
          <Folder />
          <span className="project-name" title={project.cwd}>
            {project.name}
          </span>
          {project.pinned && <Pin className="pin-mark" />}
          {project.sessions.length > 1 && (
            <small
              className="project-session-count"
              title={`${project.sessions.length} 个会话`}
            >
              · {project.sessions.length}
            </small>
          )}
        </button>
        <button
          className="project-add"
          title={`在 ${project.name} 中新建会话`}
          aria-label={`在 ${project.name} 中新建会话`}
          onClick={onAdd}
        >
          <Plus />
        </button>
        <button
          className="project-add"
          title="项目菜单"
          aria-label={`${project.name} 项目菜单`}
          onClick={() => setMenu(true)}
        >
          <MoreHorizontal />
        </button>
        {menu && (
          <ProjectMenu
            project={project}
            library={library}
            onClose={() => setMenu(false)}
            onPin={onPin}
            onHide={onHide}
            onRename={onRename}
            onDefaults={onDefaults}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        )}
      </div>
      {visible.map((thread) => {
        const key = sessionKey(thread);
        const unseen = unseenSessions.has(key);
        const forks = forkCounts.get(thread.id) || 0;
        const provider = providerById.get(thread.providerId);
        const searchMatch = searchMatches.get(
          `${thread.agentId || "codex"}:${thread.id}`,
        );
        const agentLabel = agentShortName(thread.agentId);
        const providerLabel =
          provider?.name ||
          (thread.agentId && thread.agentId !== "codex"
            ? ""
            : thread.providerId);
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            className={`session-row ${selected === key ? "selected" : ""} ${thread.forkedFromId ? "session-row--fork" : ""}`}
            onClick={() => onSelect(thread, searchMatch)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(thread, searchMatch);
              }
            }}
          >
            <div className="session-row-top">
              <strong title={thread.name}>{thread.name}</strong>
              {(thread.status !== "idle" || thread.compacting || unseen) && (
                <Status
                  status={thread.compacting ? "running" : thread.status}
                  compact
                  unseen={unseen}
                  label={thread.compacting ? "正在运行" : undefined}
                />
              )}
              <button
                type="button"
                className="session-row-more"
                title="会话操作"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSessionMenu(thread);
                }}
              >
                <MoreHorizontal />
              </button>
            </div>
            <div
              className="thread-meta"
              title={[agentLabel, providerLabel, thread.model]
                .filter(Boolean)
                .join(" · ")}
            >
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
                className={`agent-badge agent-${thread.agentId || "codex"}`}
                title={`${agentLabel} 任务`}
              >
                {agentLabel}
              </small>
              {providerLabel &&
              (searchQuery.trim() ||
                thread.providerId !==
                  commonProviderByAgent.get(thread.agentId || "codex")) ? (
                <small
                  className="provider-badge session-provider"
                  style={
                    {
                      "--provider": provider?.color || "#8b6cff",
                    } as CSSProperties
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
              {thread.controlMode === "history" && (
                <small
                  className="history-badge"
                  onClick={(event) => {
                    event.stopPropagation();
                    onHistory(thread);
                  }}
                >
                  历史
                </small>
              )}
              {thread.locked ? (
                <small
                  className="lock-badge"
                  title="会话正被其它进程占用，仅可查看历史"
                >
                  <Lock />
                  占用中
                </small>
              ) : null}
              {forks > 0 && <small>{forks} 分支</small>}
            </div>
            {searchMatch && (
              <p className="session-search-hit">
                <small>{searchMatch.role === "user" ? "你" : agentLabel}</small>
                <SearchHighlight
                  text={searchMatch.snippet}
                  query={searchQuery}
                />
              </p>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <button type="button" className="session-more" onClick={onToggle}>
          其余 {hiddenCount} 条
        </button>
      )}
    </div>
  );
}

export function SearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const needle = query.trim();
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (!needle || index < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </span>
  );
}
