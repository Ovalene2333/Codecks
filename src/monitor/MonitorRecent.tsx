import { useMemo, useState } from "react";
import { Folder, MoreHorizontal } from "lucide-react";
import { agentShortName } from "../agents";
import { distinctPreview, relativeTime, sessionKey } from "../format";
import type { ProjectGroup } from "../projects";
import { SearchHighlight } from "../project/ProjectGroup";
import type { SessionSearchMatch, ThreadSummary } from "../types";
import { contextPercent, contextTone } from "./activity";

const GROUP_LIMIT = 5;

function MonitorRow({
  thread,
  searchMatch,
  query,
  onSelect,
  onSessionMenu,
  onHistory,
}: {
  thread: ThreadSummary;
  searchMatch?: SessionSearchMatch;
  query: string;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  onHistory: (thread: ThreadSummary) => void;
}) {
  const agentId = thread.agentId || "codex";
  const agentLabel = agentShortName(agentId);
  const preview = distinctPreview(thread.name, thread.preview || "");
  const context = contextPercent(thread.tokenUsage);
  return (
    <div className="monitor-row">
      <button
        type="button"
        className="monitor-row-main"
        title={preview ? `${thread.name}\n${preview}` : thread.name}
        onClick={() => onSelect(thread, searchMatch)}
      >
        <span className="monitor-row-name">{thread.name}</span>
        <small className={`agent-badge agent-${agentId}`}>{agentLabel}</small>
        <time>{relativeTime(thread.updatedAt)}</time>
        <span className={`monitor-row-context ${contextTone(context)}`}>
          {context != null ? `${context}%` : ""}
        </span>
        {searchMatch ? (
          <span className="monitor-row-hit">
            <small>{searchMatch.role === "user" ? "你" : agentLabel}</small>
            <SearchHighlight text={searchMatch.snippet} query={query} />
          </span>
        ) : null}
      </button>
      {thread.controlMode === "history" ? (
        <button
          type="button"
          className="monitor-row-history"
          onClick={() => onHistory(thread)}
        >
          历史
        </button>
      ) : null}
      <button
        type="button"
        className="session-row-more"
        title="会话操作"
        aria-label="会话操作"
        onClick={() => onSessionMenu(thread)}
      >
        <MoreHorizontal />
      </button>
    </div>
  );
}

/** 搜索结果：按项目分组压成单行，便于扫读与定位。 */
export function MonitorRecent({
  threads,
  projectOf,
  searchMatches,
  query,
  onSelect,
  onSessionMenu,
  onHistory,
}: {
  threads: ThreadSummary[];
  projectOf: ReadonlyMap<string, ProjectGroup>;
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  query: string;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  onHistory: (thread: ThreadSummary) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // threads 已按更新时间倒序，Map 的插入顺序即“最近活跃的项目在前”。
  const groups = useMemo(() => {
    const byProject = new Map<
      string,
      { key: string; name: string; cwd: string; sessions: ThreadSummary[] }
    >();
    for (const thread of threads) {
      const project = projectOf.get(sessionKey(thread));
      const key = project?.key || thread.cwd || "";
      let group = byProject.get(key);
      if (!group) {
        group = {
          key,
          name: project?.name || thread.cwd || "未指定路径",
          cwd: project?.cwd || thread.cwd || "",
          sessions: [],
        };
        byProject.set(key, group);
      }
      group.sessions.push(thread);
    }
    return [...byProject.values()];
  }, [threads, projectOf]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="monitor-projects">
      {groups.map((group) => {
        const open = Boolean(query) || expanded.has(group.key);
        const visible = open ? group.sessions : group.sessions.slice(0, GROUP_LIMIT);
        const hidden = group.sessions.length - visible.length;
        return (
          <section key={group.key} className="monitor-project">
            <header className="monitor-project-head" title={group.cwd}>
              <Folder aria-hidden="true" />
              <h3>{group.name}</h3>
              <span>{group.sessions.length}</span>
            </header>
            {visible.map((thread) => {
              const key = sessionKey(thread);
              return (
                <MonitorRow
                  key={key}
                  thread={thread}
                  searchMatch={searchMatches.get(
                    `${thread.agentId || "codex"}:${thread.id}`,
                  )}
                  query={query}
                  onSelect={onSelect}
                  onSessionMenu={onSessionMenu}
                  onHistory={onHistory}
                />
              );
            })}
            {hidden > 0 || (open && !query && group.sessions.length > GROUP_LIMIT) ? (
              <button
                type="button"
                className="monitor-project-more"
                onClick={() => toggle(group.key)}
              >
                {hidden > 0 ? `展开其余 ${hidden} 个` : "收起"}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
