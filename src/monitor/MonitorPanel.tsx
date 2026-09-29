import { useCallback, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Menu, Search } from "lucide-react";
import { sessionKey } from "../format";
import type { DeckNotificationPermission } from "../notifications";
import type { ProjectGroup } from "../projects";
import { approvalBelongsToThread } from "../session/approvals";
import type { UsageView } from "../usage/UsageChip";
import type {
  AgentDescriptor,
  Approval,
  ApprovalResolveBody,
  Provider,
  RuntimeSnapshot,
  SessionSearchMatch,
  ThreadActivity,
  ThreadSummary,
} from "../types";
import { stalledFor } from "./activity";
import { activityKey, useActivities, useNow } from "./activity-store";
import { healthIssueCount } from "./health";
import { MonitorApprovals } from "./MonitorApprovals";
import { MonitorCard } from "./MonitorCard";
import { MonitorHealth } from "./MonitorHealth";
import { MonitorUsage } from "./MonitorUsage";

const RECENT_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 8;

const activityOf = (
  activities: ReadonlyMap<string, ThreadActivity>,
  thread: ThreadSummary,
) => activities.get(activityKey(thread.agentId, thread.id));

function scrollToPanel(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 一行状态计数；“疑似卡住”随时间变化，单独订阅秒级节拍。 */
function StatusStrip({
  counts,
  active,
  activities,
}: {
  counts: { running: number; waiting: number; error: number; unseen: number; standby: number };
  active: ThreadSummary[];
  activities: ReadonlyMap<string, ThreadActivity>;
}) {
  const now = useNow();
  const stalled = active.filter(
    (thread) => stalledFor(thread, activityOf(activities, thread), now) != null,
  ).length;
  const items = [
    { key: "running", label: "运行中", count: counts.running },
    { key: "waiting", label: "待处理", count: counts.waiting },
    { key: "stalled", label: "疑似卡住", count: stalled },
    { key: "error", label: "异常", count: counts.error },
    { key: "unseen", label: "新输出", count: counts.unseen },
    { key: "standby", label: "待命", count: counts.standby },
  ];
  return (
    <div className="monitor-strip" aria-label="会话状态">
      {items.map((item) => (
        <span key={item.key} className={`monitor-strip-item ${item.key} ${item.count ? "" : "zero"}`}>
          <i aria-hidden="true" />
          {item.label}
          <b>{item.count}</b>
        </span>
      ))}
    </div>
  );
}

export function MonitorPanel({
  groups,
  selected,
  unseenSessions,
  approvals,
  providers,
  agents,
  runtime,
  threads,
  liveThreads,
  forkCounts,
  searchMatches,
  query,
  loading,
  notificationPermission,
  onSelect,
  onOpenThread,
  onClose,
  onOpenSidebar,
  onSessionMenu,
  onHistory,
  onResolveApproval,
  onRequestNotifications,
  onRefreshLimits,
  onOpenUsage,
  onOpenAgentSettings,
}: {
  groups: ProjectGroup[];
  selected?: string;
  unseenSessions: ReadonlySet<string>;
  approvals: Approval[];
  providers: Provider[];
  agents: AgentDescriptor[];
  runtime?: RuntimeSnapshot;
  /** 含归档：审批要能找回所属会话。 */
  threads: ThreadSummary[];
  /** 未归档会话：用量与健康统计只看这些。 */
  liveThreads: ThreadSummary[];
  forkCounts: Map<string, number>;
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  query: string;
  loading: boolean;
  notificationPermission: DeckNotificationPermission;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onOpenThread: (thread: ThreadSummary) => void;
  onClose: () => void;
  onOpenSidebar: () => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  onHistory: (thread: ThreadSummary) => void;
  onResolveApproval: (id: string, body: ApprovalResolveBody) => void | Promise<void>;
  onRequestNotifications: () => void;
  onRefreshLimits: (force?: boolean) => Promise<void>;
  onOpenUsage: (view: UsageView) => void;
  /** 打开设置的 Agent 页（启用/停用/重载）。 */
  onOpenAgentSettings?: () => void;
}) {
  const activities = useActivities();
  const [focusedApproval, setFocusedApproval] = useState<string>();
  // 固定同一状态组内的顺序；流式输出更新时间时不让卡片来回换位。
  const firstSeen = useRef(new Map<string, number>());
  const nextOrder = useRef(0);
  const { active, recent, older, projectOf, approvalsByThread } =
    useMemo(() => {
      const seen = new Set<string>();
      const projects = new Map<string, ProjectGroup>();
      const pending = new Map<string, Approval[]>();
      const active: ThreadSummary[] = [];
      const recent: ThreadSummary[] = [];
      const older: ThreadSummary[] = [];
      const now = Date.now();
      for (const group of groups) {
        for (const thread of group.sessions) {
          const key = sessionKey(thread);
          seen.add(key);
          projects.set(key, group);
          if (!firstSeen.current.has(key))
            firstSeen.current.set(key, nextOrder.current++);
          const requests = approvals.filter((item) =>
            approvalBelongsToThread(item, thread),
          );
          if (requests.length) pending.set(key, requests);
          if (
            requests.length ||
            thread.compacting ||
            thread.status === "running" ||
            thread.status === "waiting" ||
            thread.status === "error" ||
            unseenSessions.has(key)
          ) {
            active.push(thread);
          } else if (now - thread.updatedAt <= RECENT_MS) {
            recent.push(thread);
          } else {
            older.push(thread);
          }
        }
      }
      const order = (a: ThreadSummary, b: ThreadSummary) =>
        (firstSeen.current.get(sessionKey(a)) || 0) -
        (firstSeen.current.get(sessionKey(b)) || 0);
      const priority = (thread: ThreadSummary) => {
        if (pending.has(sessionKey(thread)) || thread.status === "waiting")
          return 0;
        if (thread.status === "error") return 1;
        if (thread.status === "running" || thread.compacting) return 2;
        return 3;
      };
      active.sort((a, b) => priority(a) - priority(b) || order(a, b));
      recent.sort((a, b) => b.updatedAt - a.updatedAt || order(a, b));
      older.sort((a, b) => b.updatedAt - a.updatedAt || order(a, b));
      for (const key of firstSeen.current.keys()) {
        if (!seen.has(key)) firstSeen.current.delete(key);
      }
      return {
        active,
        recent,
        older,
        projectOf: projects,
        approvalsByThread: pending,
      };
    }, [groups, approvals, unseenSessions]);

  const other = [...recent, ...older];
  const pendingOf = (thread: ThreadSummary) =>
    approvalsByThread.get(sessionKey(thread));
  const running = active.filter(
    (thread) =>
      (thread.status === "running" || thread.compacting) && !pendingOf(thread),
  ).length;
  const waiting = active.filter(
    (thread) => thread.status === "waiting" || pendingOf(thread),
  ).length;
  const error = active.filter(
    (thread) => thread.status === "error" && !pendingOf(thread),
  ).length;
  const counts = {
    running,
    waiting,
    error,
    unseen: Math.max(0, active.length - running - waiting - error),
    standby: other.length,
  };
  const issues = healthIssueCount(agents, providers);

  const focusApproval = useCallback((id: string) => {
    setFocusedApproval(id);
    scrollToPanel("monitor-approvals");
  }, []);
  const renderCard = (thread: ThreadSummary) => {
    const key = sessionKey(thread);
    return (
      <MonitorCard
        key={key}
        thread={thread}
        activity={activityOf(activities, thread)}
        selected={selected}
        unseen={unseenSessions.has(key)}
        project={projectOf.get(key)}
        pending={approvalsByThread.get(key) || []}
        providers={providers}
        forkCount={forkCounts.get(thread.id) || 0}
        searchMatch={searchMatches.get(`${thread.agentId || "codex"}:${thread.id}`)}
        query={query}
        onSelect={onSelect}
        onSessionMenu={onSessionMenu}
        onHistory={onHistory}
        onResolveApproval={onResolveApproval}
        onFocusApproval={focusApproval}
      />
    );
  };

  return (
    <main className="monitor-view">
      <header className="monitor-header">
        <button
          type="button"
          className="icon-btn monitor-menu"
          title="打开会话列表"
          aria-label="打开会话列表"
          onClick={onOpenSidebar}
        >
          <Menu />
        </button>
        <h1>监控台</h1>
        <button
          type="button"
          className={`monitor-health-chip ${issues ? "warn" : ""}`}
          onClick={() => scrollToPanel("monitor-health")}
          title="查看运行健康"
        >
          <i aria-hidden="true" />
          {issues ? `${issues} 项异常` : "运行正常"}
        </button>
        <button type="button" className="monitor-return" onClick={onClose}>
          <ArrowLeft />
          返回{selected ? "对话" : "工作区"}
        </button>
      </header>
      <div className="monitor-scroll">
        <div className="monitor-content">
          <StatusStrip counts={counts} active={active} activities={activities} />
          <div className="monitor-layout">
            <div className="monitor-main">
              {approvals.length ? (
                <MonitorApprovals
                  approvals={approvals}
                  threads={threads}
                  activeId={focusedApproval}
                  onActiveChange={setFocusedApproval}
                  notificationPermission={notificationPermission}
                  onRequestNotifications={onRequestNotifications}
                  onOpenThread={onOpenThread}
                  onResolve={onResolveApproval}
                />
              ) : null}
              {active.length > 0 && (
                <section className="monitor-section" aria-label="进行中与待处理">
                  <div className="monitor-section-heading">
                    <span className="monitor-section-dot active" />
                    <h2>进行中与待处理</h2>
                    <span>{active.length}</span>
                  </div>
                  <div className="monitor-grid">{active.map(renderCard)}</div>
                </section>
              )}
              {other.length > 0 && (
                <section className="monitor-section" aria-label="最近会话">
                  <div className="monitor-section-heading">
                    <span className="monitor-section-dot" />
                    <h2>最近会话</h2>
                    <span>{other.length}</span>
                  </div>
                  <div className="monitor-grid">
                    {other.slice(0, RECENT_LIMIT).map(renderCard)}
                  </div>
                  {other.length > RECENT_LIMIT && (
                    <p className="monitor-more">
                      另有 {other.length - RECENT_LIMIT} 个会话，可在左侧列表查看
                    </p>
                  )}
                </section>
              )}
              {!active.length && !other.length && (
                <div className="monitor-empty">
                  {query ? <Search /> : <Activity />}
                  <h2>
                    {loading
                      ? "正在读取会话…"
                      : query
                        ? "没有匹配的会话"
                        : "暂无会话"}
                  </h2>
                  <p>可在左侧列表搜索、筛选或新建会话。</p>
                </div>
              )}
            </div>
            <aside className="monitor-aside">
              <MonitorUsage
                threads={liveThreads}
                runtime={runtime}
                onSelect={onSelect}
                onRefreshLimits={onRefreshLimits}
                onOpenUsage={onOpenUsage}
              />
              <MonitorHealth
                agents={agents}
                providers={providers}
                threads={liveThreads}
                onOpenAgentSettings={onOpenAgentSettings}
              />
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}
