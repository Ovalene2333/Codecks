import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, LayoutList, Plus, Search, SunMoon } from "lucide-react";
import { sessionKey } from "../format";
import { Button } from "../kit";
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
  LostWakeWatcher,
  WakeDelivery,
  WakeWatcher,
} from "../types";
import { stalledFor } from "./activity";
import { activityKey, useActivities, useNow } from "./activity-store";
import { healthIssueCount } from "./health";
import { DEFAULT_LAYOUT, isDefaultLayout, useMonitorLayout } from "./layout";
import { ASIDE_PANEL_META, LayoutEditor, MAIN_PANEL_META } from "./LayoutEditor";
import { MonitorApprovals } from "./MonitorApprovals";
import { MonitorBoard } from "./MonitorBoard";
import { MonitorHealth } from "./MonitorHealth";
import { MonitorRecent } from "./MonitorRecent";
import { MonitorUsage } from "./MonitorUsage";

const activityOf = (
  activities: ReadonlyMap<string, ThreadActivity>,
  thread: ThreadSummary,
) => activities.get(activityKey(thread.agentId, thread.id));

function scrollToPanel(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface StatusCounts {
  running: number;
  waiting: number;
  error: number;
  unseen: number;
}

/**
 * 一行状态计数，数量为 0 的不显示，点一下滚到对应列表；
 * “疑似卡住”随时间变化，单独订阅节拍。
 */
function StatusStrip({
  counts,
  threads,
  activities,
  hasApprovals,
}: {
  counts: StatusCounts;
  threads: ThreadSummary[];
  activities: ReadonlyMap<string, ThreadActivity>;
  hasApprovals: boolean;
}) {
  const now = useNow(5_000);
  const stalled = threads.filter(
    (thread) => stalledFor(thread, activityOf(activities, thread), now) != null,
  ).length;
  const items = [
    {
      key: "waiting",
      label: "待处理",
      count: counts.waiting,
      target: hasApprovals ? "monitor-approvals" : "home-attention",
    },
    { key: "error", label: "异常", count: counts.error, target: "home-attention" },
    { key: "unseen", label: "新回复", count: counts.unseen, target: "home-unseen" },
    { key: "running", label: "运行中", count: counts.running, target: "home-running" },
    { key: "stalled", label: "疑似卡住", count: stalled, target: "home-running" },
  ].filter((item) => item.count > 0);
  return (
    <div className="monitor-strip" aria-label="会话状态">
      {items.length ? (
        items.map((item) => (
          <button
            type="button"
            key={item.key}
            className={`monitor-strip-item ${item.key}`}
            onClick={() => scrollToPanel(item.target)}
          >
            <i aria-hidden="true" />
            {item.label}
            <b>{item.count}</b>
          </button>
        ))
      ) : (
        <span className="monitor-strip-idle">没有需要你处理的事，也没有正在运行的任务</span>
      )}
    </div>
  );
}

/** 总览首页：打开 Deck 先看这里——什么在等你、什么刚交回来、什么还在跑。 */
export function MonitorPanel({
  groups,
  unseenSessions,
  approvals,
  providers,
  agents,
  runtime,
  threads,
  liveThreads,
  deliveries,
  watchers,
  lostWatchers,
  searchMatches,
  query,
  loading,
  notificationPermission,
  onSelect,
  onOpenThread,
  onShowAll,
  onNew,
  onAppearance,
  onMarkSeen,
  onMarkAllSeen,
  onSessionMenu,
  onHistory,
  onResolveApproval,
  onRequestNotifications,
  onRefreshLimits,
  onOpenUsage,
  onOpenAgentSettings,
}: {
  /** 现有库的项目分组；搜索时为搜索结果。 */
  groups: ProjectGroup[];
  unseenSessions: ReadonlySet<string>;
  approvals: Approval[];
  providers: Provider[];
  agents: AgentDescriptor[];
  runtime?: RuntimeSnapshot;
  /** 含归档：审批要能找回所属会话。 */
  threads: ThreadSummary[];
  /** 未归档会话：用量与健康统计只看这些。 */
  liveThreads: ThreadSummary[];
  /** 唤醒投递队列（snapshot 下发）；「需要处理」展示失败中的条目。 */
  deliveries: WakeDelivery[];
  /** deck-wake watcher 列表（snapshot 下发，服务端缓存）。 */
  watchers?: WakeWatcher[];
  /** 失联待处理的 watcher（snapshot 下发）。 */
  lostWatchers?: LostWakeWatcher[];
  searchMatches: ReadonlyMap<string, SessionSearchMatch>;
  query: string;
  loading: boolean;
  notificationPermission: DeckNotificationPermission;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onOpenThread: (thread: ThreadSummary) => void;
  /** 「查看全部会话」：移动端进 /sessions（桌面端侧栏常驻，按钮不显示）。 */
  onShowAll: () => void;
  onNew: () => void;
  onAppearance: () => void;
  onMarkSeen: (key: string) => void;
  onMarkAllSeen: () => void;
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
  const { all, projectOf, approvalsByThread, counts } = useMemo(() => {
    const all: ThreadSummary[] = [];
    const projects = new Map<string, ProjectGroup>();
    const pending = new Map<string, Approval[]>();
    const counts: StatusCounts = { running: 0, waiting: 0, error: 0, unseen: 0 };
    for (const group of groups) {
      for (const thread of group.sessions) {
        const key = sessionKey(thread);
        all.push(thread);
        projects.set(key, group);
        const requests = approvals.filter((item) =>
          approvalBelongsToThread(item, thread),
        );
        if (requests.length) pending.set(key, requests);
        if (requests.length || thread.status === "waiting") counts.waiting++;
        else if (thread.status === "error") counts.error++;
        else if (thread.status === "running" || thread.compacting) counts.running++;
        else if (unseenSessions.has(key)) counts.unseen++;
      }
    }
    return { all, projectOf: projects, approvalsByThread: pending, counts };
  }, [groups, approvals, unseenSessions]);

  const searching = Boolean(query);
  const byRecency = useMemo(
    () => (searching ? [...all].sort((a, b) => b.updatedAt - a.updatedAt) : []),
    [all, searching],
  );
  const issues = healthIssueCount(agents, providers);
  const openThread = useCallback((thread: ThreadSummary) => onSelect(thread), [onSelect]);
  const [layout, setLayout] = useMonitorLayout();
  // 「调整布局」编辑态只是页内临时状态：刷新/返回后回到正常首页即可，不进 URL。
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  return (
    <main className="monitor-view">
      <header className="monitor-header">
        <h1>总览</h1>
        <button
          type="button"
          className={`monitor-health-chip ${issues ? "warn" : ""}`}
          onClick={() => scrollToPanel("monitor-health")}
          title="查看运行健康"
        >
          <i aria-hidden="true" />
          {issues ? `${issues} 项异常` : "运行正常"}
        </button>
        <Button variant="primary" size="sm" className="monitor-new" onClick={onNew}>
          <Plus aria-hidden="true" />
          <span>新建</span>
        </Button>
        <button
          type="button"
          className={`icon-btn monitor-layout-toggle${editing ? " active" : ""}`}
          title={editing ? "完成调整" : "调整布局"}
          aria-label="调整布局"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          <LayoutList />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="外观设置"
          aria-label="外观设置"
          onClick={onAppearance}
        >
          <SunMoon />
        </button>
      </header>
      <div className="monitor-scroll">
        <div className="monitor-content">
          {editing ? (
            <div className="monitor-layout-bar">
              <p>
                按住拖动或用箭头调整顺序，主栏和右栏各自排列；审批卡片固定在最上方。
                顺序只保存在这台设备上。
              </p>
              <div className="monitor-layout-bar-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isDefaultLayout(layout)}
                  onClick={() => setLayout(DEFAULT_LAYOUT)}
                >
                  恢复默认
                </Button>
                <Button size="sm" variant="primary" onClick={() => setEditing(false)}>
                  完成
                </Button>
              </div>
            </div>
          ) : searching ? null : (
            <StatusStrip
              counts={counts}
              threads={all}
              activities={activities}
              hasApprovals={approvals.length > 0}
            />
          )}
          <div className="monitor-layout">
            <div className="monitor-main">
              {editing ? (
                <LayoutEditor
                  label="主栏"
                  order={layout.main}
                  meta={MAIN_PANEL_META}
                  onChange={(main) => setLayout({ ...layout, main })}
                />
              ) : (
                <>
                  {approvals.length && !searching ? (
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
                  {all.length === 0 ? (
                    <div className="monitor-empty">
                      {query ? <Search /> : <Activity />}
                      <h2>
                        {loading
                          ? "正在读取会话…"
                          : query
                            ? "没有匹配的会话"
                            : "暂无会话"}
                      </h2>
                      <p>可在会话列表搜索、筛选或新建会话。</p>
                    </div>
                  ) : searching ? (
                    <section className="monitor-section" aria-label="搜索结果">
                      <div className="monitor-section-heading">
                        <h2>搜索结果</h2>
                        <span>{byRecency.length}</span>
                      </div>
                      <MonitorRecent
                        threads={byRecency}
                        projectOf={projectOf}
                        searchMatches={searchMatches}
                        query={query}
                        onSelect={onSelect}
                        onSessionMenu={onSessionMenu}
                        onHistory={onHistory}
                      />
                    </section>
                  ) : (
                    <MonitorBoard
                      order={layout.main}
                      threads={all}
                      activities={activities}
                      approvalsByThread={approvalsByThread}
                      unseenSessions={unseenSessions}
                      deliveries={deliveries}
                      watchers={watchers}
                      lostWatchers={lostWatchers}
                      projectOf={projectOf}
                      onOpen={openThread}
                      onMarkSeen={onMarkSeen}
                      onMarkAllSeen={onMarkAllSeen}
                      onSessionMenu={onSessionMenu}
                      onShowAll={onShowAll}
                    />
                  )}
                </>
              )}
            </div>
            <aside className="monitor-aside">
              {editing ? (
                <LayoutEditor
                  label="右栏"
                  order={layout.aside}
                  meta={ASIDE_PANEL_META}
                  onChange={(aside) => setLayout({ ...layout, aside })}
                />
              ) : (
                layout.aside.map((id) =>
                  id === "usage" ? (
                    <MonitorUsage
                      key={id}
                      threads={liveThreads}
                      runtime={runtime}
                      onSelect={onSelect}
                      onRefreshLimits={onRefreshLimits}
                      onOpenUsage={onOpenUsage}
                    />
                  ) : (
                    <MonitorHealth
                      key={id}
                      agents={agents}
                      providers={providers}
                      threads={liveThreads}
                      onOpenAgentSettings={onOpenAgentSettings}
                    />
                  ),
                )
              )}
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}
