import { useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pin,
  Plus,
} from "lucide-react";
import { previewSessions } from "../projects";
import type { ProjectGroup as ProjectGroupData } from "../projects";
import type { Provider, ThreadSummary } from "../types";
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
  onToggle: () => void;
  onSelect: (thread: ThreadSummary) => void;
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
  const visible = previewSessions(project.sessions, !collapsed);
  const hiddenCount = project.sessions.length - visible.length;
  const providerById = new Map(
    providers.map((item) => [item.id, item] as const),
  );
  return (
    <div className={`project-group ${project.pinned ? "pinned" : ""}`}>
      <div className="project-heading">
        <button className="project-toggle" onClick={onToggle}>
          {collapsed ? <ChevronRight /> : <ChevronDown />}
          <Folder />
          <span title={project.cwd}>{project.name}</span>
          {project.pinned && <Pin className="pin-mark" />}
        </button>
        <b>{project.sessions.length}</b>
        <button
          className="project-add"
          title={`在 ${project.name} 中新建会话`}
          onClick={onAdd}
        >
          <Plus />
        </button>
        <button
          className="project-add"
          title="项目菜单"
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
        const agentLabel = thread.agentId === "claude" ? "Claude" : "Codex";
        const providerLabel =
          provider?.name ||
          (thread.agentId === "claude" ? "" : thread.providerId);
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            className={`session-row ${selected === key ? "selected" : ""} ${thread.forkedFromId ? "session-row--fork" : ""}`}
            onClick={() => onSelect(thread)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(thread);
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
            <div className="thread-meta">
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
              {providerLabel ? (
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
              <small
                className={
                  thread.controlMode === "history"
                    ? "history-badge"
                    : "mode-badge"
                }
                onClick={
                  thread.controlMode === "history"
                    ? (event) => {
                        event.stopPropagation();
                        onHistory(thread);
                      }
                    : undefined
                }
              >
                {thread.controlMode === "managed" ? "受管" : "历史"}
              </small>
              {forks > 0 && <small>{forks} 分支</small>}
            </div>
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
