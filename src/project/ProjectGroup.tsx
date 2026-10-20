import { useState, type CSSProperties, type PointerEvent } from "react";
import {
  ChevronDown,
  Folder,
  GripVertical,
  Lock,
  MoreHorizontal,
  Pin,
  GitBranch,
  Plus,
  Radar,
} from "lucide-react";
import { askStatusLabel } from "../session/AskNotice";
import { agentShortName } from "../agents";
import { previewSessions } from "../projects";
import type { ProjectGroup as ProjectGroupData } from "../projects";
import type {
  Provider,
  SessionSearchMatch,
  SessionWakeState,
  ThreadSummary,
} from "../types";
import { relativeTime, sessionKey } from "../format";
import { branchInfo, type SessionBranchRelation } from "../session-branch";
import { ProjectMenu } from "./ProjectMenu";

const SESSION_STATUS_LABELS: Record<ThreadSummary["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting: "待确认",
  idle: "",
  error: "异常",
  offline: "离线",
};

export function ProjectGroupView({
  project,
  library,
  selected,
  unseenSessions,
  wakeStates,
  branches,
  collapsed,
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
  reorderMode,
  onProjectDragStart,
  onSessionDragStart,
  registerProjectRow,
  registerSessionRow,
}: {
  project: ProjectGroupData;
  library: "active" | "archived";
  selected?: string;
  unseenSessions: ReadonlySet<string>;
  /** 会话的 deck-api 标记（键为 sessionKey）。 */
  wakeStates?: ReadonlyMap<string, SessionWakeState>;
  /** 会话的分支关系（键为 sessionKey，覆盖 active + archived）。 */
  branches?: ReadonlyMap<string, SessionBranchRelation>;
  collapsed: boolean;
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
  /** 拖动排序模式：显示手柄，点击手柄开始拖动。 */
  reorderMode?: boolean;
  onProjectDragStart?: (event: PointerEvent<HTMLElement>, key: string) => void;
  onSessionDragStart?: (
    event: PointerEvent<HTMLElement>,
    projectKey: string,
    key: string,
  ) => void;
  registerProjectRow?: (key: string, node: HTMLElement | null) => void;
  registerSessionRow?: (key: string, node: HTMLElement | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  // 拖动排序时折叠就是完全折叠：不留预览会话，项目行之间才看得清、拖得准。
  const fullyCollapsed = Boolean(reorderMode) && collapsed;
  const visible = fullyCollapsed
    ? []
    : previewSessions(project.sessions, !collapsed, {
        isPinned: (thread) => {
          const key = sessionKey(thread);
          return key === selected || unseenSessions.has(key);
        },
      });
  const hiddenCount = fullyCollapsed
    ? 0
    : project.sessions.length - visible.length;
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
    <div
      className={`project-group ${project.pinned ? "pinned" : ""} ${visible.length > 0 ? "is-expanded" : ""} ${reorderMode ? "is-reordering" : ""}`}
    >
      <div
        className="project-heading"
        ref={(node) => registerProjectRow?.(project.key, node)}
      >
        {reorderMode && (
          <button
            type="button"
            className="sidebar-drag-handle"
            title="拖动手柄调整项目顺序"
            aria-label={`拖动 ${project.name} 调整顺序`}
            onPointerDown={(event) => onProjectDragStart?.(event, project.key)}
          >
            <GripVertical aria-hidden="true" />
          </button>
        )}
        <button
          className="project-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "展开该项目" : "折叠该项目"}
          onClick={onToggle}
        >
          <ChevronDown
            className={`project-chevron ${collapsed ? "is-collapsed" : ""}`}
            aria-hidden="true"
          />
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
              {project.sessions.length}
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
      {(visible.length > 0 || hiddenCount > 0) && (
        <div className="project-sessions">
          {visible.map((thread) => {
            const key = sessionKey(thread);
            const unseen = unseenSessions.has(key);
            const wake = wakeStates?.get(key);
            const branch = branches
              ? branchInfo(key, branches)
              : { isBranch: false, depth: 0, childCount: 0 };
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
            const effectiveStatus = thread.compacting
              ? "running"
              : thread.status;
            const showUnseen = Boolean(unseen && effectiveStatus === "idle");
            const statusTone = showUnseen
              ? "unseen"
              : effectiveStatus !== "idle"
                ? effectiveStatus
                : "idle";
            const statusText = showUnseen
              ? "新回复"
              : thread.compacting
                ? "运行中"
                : SESSION_STATUS_LABELS[effectiveStatus];
            const isAttention =
              effectiveStatus === "waiting" ||
              effectiveStatus === "error" ||
              unseen;
            return (
              <div
                key={key}
                ref={(node) => registerSessionRow?.(key, node)}
                data-project-key={project.key}
                role="button"
                tabIndex={0}
                className={[
                  "session-row",
                  selected === key ? "selected" : "",
                  isAttention ? "is-attention" : "",
                  branch.isBranch ? "session-row--fork" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-branch-depth={
                  branch.isBranch
                    ? String(Math.min(branch.depth, 3))
                    : undefined
                }
                aria-label={[
                  thread.name,
                  branch.isBranch ? "分支会话" : "",
                  branch.childCount ? `含 ${branch.childCount} 个分支` : "",
                ]
                  .filter(Boolean)
                  .join("，")}
                onClick={(event) => {
                  // 拖动手柄松开时也会在行上补一个 click：不要顺手打开会话。
                  if (reorderMode) return;
                  void event;
                  onSelect(thread, searchMatch);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(thread, searchMatch);
                  }
                }}
              >
                <div className="session-row-top">
                  {reorderMode && (
                    <button
                      type="button"
                      className="sidebar-drag-handle session-drag-handle"
                      title="拖动手柄调整会话顺序"
                      aria-label={`拖动 ${thread.name} 调整顺序`}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        onSessionDragStart?.(event, project.key, key);
                      }}
                    >
                      <GripVertical aria-hidden="true" />
                    </button>
                  )}
                  <strong title={thread.name}>{thread.name}</strong>
                  <button
                    type="button"
                    className="session-row-more"
                    title="会话操作"
                    aria-label={`${thread.name} 会话操作`}
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
                  <small
                    className={`agent-badge agent-${thread.agentId || "codex"}`}
                    title={`${agentLabel} 任务`}
                  >
                    {agentLabel}
                  </small>
                  {thread.ask && (
                    <small className="ask-badge" title={`Agent 询问 · ${askStatusLabel(thread.ask)}`}>
                      询问
                    </small>
                  )}
                  {branch.isBranch && (
                    <small
                      className="branch-badge"
                      title={
                        branch.depth > 0
                          ? `分支会话 · 第 ${branch.depth + 1} 层`
                          : "分支会话"
                      }
                    >
                      <GitBranch aria-hidden="true" />
                      分支
                    </small>
                  )}
                  {branch.childCount > 0 && (
                    <small
                      className="branch-count"
                      title={`${branch.childCount} 个直接分支`}
                    >
                      {branch.childCount} 分支
                    </small>
                  )}
                  {statusText ? (
                    <small
                      className={`session-status-text is-${statusTone}`}
                    >
                      <span className="session-status-ink">{statusText}</span>
                    </small>
                  ) : null}
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
                  {wake ? (
                    <small
                      className={`wake-badge ${wake}`}
                      title={
                        wake === "lost"
                          ? "deck-api 监督进程已失联，远端任务没人盯了"
                          : "deck-api 正在监督远端任务"
                      }
                    >
                      <Radar aria-hidden="true" />
                      {wake === "lost" ? "失联" : "监督中"}
                    </small>
                  ) : null}
                  <time
                    dateTime={
                      Number.isFinite(thread.updatedAt)
                        ? new Date(thread.updatedAt).toISOString()
                        : undefined
                    }
                  >
                    {relativeTime(thread.updatedAt)}
                  </time>
                </div>
                {searchMatch && (
                  <p className="session-search-hit">
                    <small>
                      {searchMatch.role === "user" ? "你" : agentLabel}
                    </small>
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
              其余 {hiddenCount} 个
            </button>
          )}
        </div>
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
