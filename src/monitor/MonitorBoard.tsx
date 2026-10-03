import { createContext, Fragment, useContext, useMemo, useState, type ReactNode } from "react";
import {
  BookOpenText,
  Bot,
  Brain,
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock3,
  Command,
  FolderSearch,
  Globe,
  Hourglass,
  Inbox,
  MessageSquareText,
  Minimize2,
  MoreHorizontal,
  OctagonMinus,
  Pencil,
  Play,
  Radar,
  RotateCw,
  Send,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { agentShortName } from "../agents";
import { post, remove } from "../api";
import { relativeTime, sessionKey } from "../format";
import { Button } from "../kit";
import type { ProjectGroup } from "../projects";
import type {
  Approval,
  LostWakeWatcher,
  ThreadActivity,
  ThreadSummary,
  WakeDelivery,
  WakeWatcher,
} from "../types";
import {
  contextPercent,
  contextTone,
  describeStep,
  formatDuration,
  formatElapsed,
  turnResultLabel,
  type StepKind,
} from "./activity";
import { activityKey, useNow } from "./activity-store";
import {
  buildHomeBoard,
  finishedAt,
  replyPreview,
  turnTone,
  type HomeItem,
  type RunningItem,
} from "./home";
import type { MainPanelId } from "./layout";
import { useWakeWatchers } from "./wake-watchers";

const STEP_ICONS: Record<StepKind, typeof Command> = {
  command: Command,
  read: BookOpenText,
  explore: FolderSearch,
  edit: Pencil,
  tool: Wrench,
  web: Globe,
  agent: Bot,
  think: Brain,
  reply: MessageSquareText,
  compact: Minimize2,
};
const RESULT_ICONS = { ok: CircleCheck, fail: CircleX, stop: OctagonMinus } as const;
const UNSEEN_LIMIT = 8;
const RECENT_LIMIT = 5;

/** 行尾「···」会话菜单（重命名、归档、在此项目新建…）；各面板共用，免得逐层透传。 */
const RowMenuContext = createContext<((thread: ThreadSummary) => void) | undefined>(
  undefined,
);

const firstLine = (text?: string) =>
  (text || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";

/** “已等 12 分钟”“已盯 3 小时”：分钟级就够，不做秒表，避免列表每秒跳动。 */
function roughly(prefix: string, ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${prefix} ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${prefix} ${hours} 小时` : `${prefix} ${Math.floor(hours / 24)} 天`;
}

const everyLabel = (seconds: number) =>
  seconds % 3_600 === 0
    ? `每 ${seconds / 3_600} 小时`
    : seconds % 60 === 0
      ? `每 ${seconds / 60} 分钟`
      : `每 ${seconds} 秒`;

function Row({
  thread,
  name,
  project,
  tone,
  lead,
  time,
  timeTitle,
  detail,
  title,
  action,
  menu = true,
  onOpen,
}: {
  /** 没有对应会话时（如代号已关闭）只显示 name，行不可点。 */
  thread?: ThreadSummary;
  name?: string;
  project?: ProjectGroup;
  tone: string;
  lead: ReactNode;
  time: ReactNode;
  timeTitle?: string;
  detail?: ReactNode;
  title?: string;
  action?: ReactNode;
  /** 行尾「···」会话菜单；自带多个操作按钮的行（投递失败）关掉，免得挤掉会话名。 */
  menu?: boolean;
  onOpen?: () => void;
}) {
  const agentId = thread ? thread.agentId || "codex" : undefined;
  const context = contextPercent(thread?.tokenUsage);
  const contextLevel = contextTone(context);
  const label = name ?? thread?.name ?? "";
  const onMenu = useContext(RowMenuContext);
  return (
    <li className={`home-row ${tone}`}>
      <button
        type="button"
        className="home-row-main"
        title={title ?? label}
        disabled={!onOpen}
        onClick={onOpen}
      >
        <span className="home-row-lead" aria-hidden="true">
          {lead}
        </span>
        <span className="home-row-head">
          <b>{label}</b>
          {agentId ? (
            <small className={`agent-badge agent-${agentId}`}>{agentShortName(agentId)}</small>
          ) : null}
          {thread ? (
            <span className="home-row-project">
              {project?.name || thread.cwd || "未指定路径"}
            </span>
          ) : null}
          {contextLevel ? (
            <em className={`home-row-ctx ${contextLevel}`} title="上下文占用">
              {context}%
            </em>
          ) : null}
        </span>
        <time title={timeTitle}>{time}</time>
        {detail ? <span className="home-row-detail">{detail}</span> : null}
      </button>
      {action}
      {thread && onMenu && menu ? (
        <button
          type="button"
          className="home-row-done home-row-more"
          title="会话操作"
          aria-label={`${label} 的会话操作`}
          onClick={() => onMenu(thread)}
        >
          <MoreHorizontal />
        </button>
      ) : null}
    </li>
  );
}

function Panel({
  id,
  tone,
  Icon,
  title,
  count,
  actions,
  footer,
  children,
}: {
  id: string;
  tone: string;
  Icon: typeof Command;
  title: string;
  count?: number;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`monitor-panel home-panel ${tone}`} aria-label={title}>
      <div className="monitor-panel-head">
        <Icon aria-hidden="true" />
        <h2>{title}</h2>
        {count ? <span className="home-count">{count}</span> : null}
        {actions ? <div className="home-panel-actions">{actions}</div> : null}
      </div>
      <ul className="home-list">{children}</ul>
      {footer}
    </section>
  );
}

/**
 * 投递不出去的唤醒：dead 需要人处理（重试或移除）；pending 且已失败过的
 * 显示为正在重试的警告行。刚入队还在首次投递的不展示。
 */
function DeliveryRow({
  delivery,
  thread,
  project,
  onOpen,
}: {
  delivery: WakeDelivery;
  thread?: ThreadSummary;
  project?: ProjectGroup;
  onOpen?: (thread: ThreadSummary) => void;
}) {
  const dead = delivery.status === "dead";
  const detail = dead
    ? firstLine(delivery.lastError) || "唤醒投递失败"
    : `已失败 ${delivery.attempts} 次`;
  const retryDelivery = () =>
    post(`/monitor/wake-deliveries/${delivery.id}/retry`).catch(() => {});
  const dismissDelivery = () =>
    remove(`/monitor/wake-deliveries/${delivery.id}`).catch(() => {});
  return (
    <Row
      thread={thread}
      name={thread ? undefined : `代号 ${delivery.code}`}
      project={project}
      tone={dead ? "error" : "stall"}
      lead={dead ? <CircleAlert /> : <Radar />}
      time={relativeTime(delivery.createdAt)}
      detail={
        <span className="home-row-step">
          <b>{dead ? "唤醒未送达" : "唤醒投递重试中"}</b>
          {delivery.preview ? <code>{firstLine(delivery.preview)}</code> : null}
          <span>{detail}</span>
        </span>
      }
      title={[
        `[wake:${delivery.code}] ${delivery.preview}`,
        delivery.lastError,
        !dead && delivery.nextAttemptAt
          ? `下次重试 ${new Date(delivery.nextAttemptAt).toLocaleTimeString("zh-CN")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")}
      onOpen={thread && onOpen ? () => onOpen(thread) : undefined}
      menu={!dead}
      action={
        dead ? (
          <>
            <button
              type="button"
              className="home-row-done"
              title="重试投递"
              aria-label="重试投递"
              onClick={retryDelivery}
            >
              <RotateCw />
            </button>
            <button
              type="button"
              className="home-row-done"
              title="移除这条唤醒"
              aria-label="移除这条唤醒"
              onClick={dismissDelivery}
            >
              <X />
            </button>
          </>
        ) : undefined
      }
    />
  );
}

/**
 * 失联的 watcher：进程没了却没发出唤醒。远端任务可能还在跑，由人决定
 * 通知会话（经唤醒队列投递一条说明）还是忽略；Deck 不自动注入。
 */
function LostRow({
  lost,
  thread,
  project,
  onOpen,
}: {
  lost: LostWakeWatcher;
  thread?: ThreadSummary;
  project?: ProjectGroup;
  onOpen?: (thread: ThreadSummary) => void;
}) {
  const notify = () =>
    post(`/monitor/lost-watchers/${lost.id}/notify`).catch(() => {});
  const dismiss = () =>
    remove(`/monitor/lost-watchers/${lost.id}`).catch(() => {});
  return (
    <Row
      thread={thread}
      name={thread ? undefined : `代号 ${lost.code}`}
      project={project}
      tone="error"
      lead={<Radar />}
      time={relativeTime(lost.endedAt)}
      timeTitle={`发现于 ${new Date(lost.endedAt).toLocaleString("zh-CN")}`}
      detail={
        <span className="home-row-step">
          <b>watcher 失联 · {lost.label}</b>
          {lost.state ? <code>{lost.state}</code> : null}
          <span>{lost.reason}</span>
        </span>
      }
      title={[
        `${lost.label} · 代号 ${lost.code} · pid ${lost.pid}`,
        lost.reason,
        lost.lastLine ? `日志末行：${lost.lastLine}` : "",
        `$ ${lost.command}`,
        lost.log ? `日志 ${lost.log}` : "",
      ]
        .filter(Boolean)
        .join("\n")}
      onOpen={thread && onOpen ? () => onOpen(thread) : undefined}
      menu={false}
      action={
        <>
          {thread ? (
            <button
              type="button"
              className="home-row-done"
              title="通知会话：发一条唤醒说明 watcher 已失联"
              aria-label="通知会话 watcher 已失联"
              onClick={notify}
            >
              <Send />
            </button>
          ) : null}
          <button
            type="button"
            className="home-row-done"
            title="忽略这条失联记录"
            aria-label="忽略这条失联记录"
            onClick={dismiss}
          >
            <X />
          </button>
        </>
      }
    />
  );
}

function AttentionPanel({
  items,
  deliveries,
  lost,
  threadOf,
  projectOf,
  onOpen,
}: {
  items: HomeItem[];
  deliveries: WakeDelivery[];
  lost: LostWakeWatcher[];
  threadOf: ReadonlyMap<string, ThreadSummary>;
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const now = useNow(30_000);
  return (
    <Panel
      id="home-attention"
      tone="attention"
      Icon={CircleAlert}
      title="需要处理"
      count={items.length + deliveries.length + lost.length}
    >
      {lost.map((item) => {
        const thread = item.threadId
          ? threadOf.get(activityKey(item.agentId, item.threadId))
          : undefined;
        return (
          <LostRow
            key={item.id}
            lost={item}
            thread={thread}
            project={thread ? projectOf.get(sessionKey(thread)) : undefined}
            onOpen={onOpen}
          />
        );
      })}
      {items.map((item) => {
        const { thread } = item;
        const failed = thread.status === "error";
        const error = firstLine(thread.lastError) || thread.errorCode || "任务失败";
        const since = item.activity?.lastEventAt ?? thread.updatedAt;
        return (
          <Row
            key={item.key}
            thread={item.thread}
            project={projectOf.get(item.key)}
            tone={failed ? "error" : "wait"}
            lead={failed ? <CircleAlert /> : <Hourglass />}
            time={failed ? relativeTime(thread.updatedAt) : roughly("已等", now - since)}
            detail={failed ? error : "等你回复"}
            title={failed ? `${thread.name}\n${thread.lastError || error}` : undefined}
            onOpen={() => onOpen(thread)}
          />
        );
      })}
      {deliveries.map((delivery) => {
        const thread = delivery.threadId
          ? threadOf.get(activityKey(delivery.agentId, delivery.threadId))
          : undefined;
        return (
          <DeliveryRow
            key={delivery.id}
            delivery={delivery}
            thread={thread}
            project={thread ? projectOf.get(sessionKey(thread)) : undefined}
            onOpen={onOpen}
          />
        );
      })}
    </Panel>
  );
}

function unseenDetail(item: HomeItem) {
  const turn = item.activity?.lastTurn;
  const reply = replyPreview(turn?.reply);
  if (!turn) return reply || "有新回复";
  const tone = turnTone(turn.status);
  const result = `${turnResultLabel(turn.status)} · 用时 ${formatDuration(turn.endedAt - turn.startedAt)}`;
  if (!reply) return result;
  return tone === "ok" ? reply : `${turnResultLabel(turn.status)} · ${reply}`;
}

function UnseenPanel({
  items,
  projectOf,
  onOpen,
  onMarkSeen,
  onMarkAllSeen,
}: {
  items: HomeItem[];
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
  onMarkSeen: (key: string) => void;
  onMarkAllSeen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, UNSEEN_LIMIT);
  const hidden = items.length - visible.length;
  return (
    <Panel
      id="home-unseen"
      tone="unseen"
      Icon={Inbox}
      title="新回复"
      count={items.length}
      actions={
        <Button size="sm" variant="ghost" onClick={onMarkAllSeen}>
          <CheckCheck aria-hidden="true" />
          全部已读
        </Button>
      }
      footer={
        items.length > UNSEEN_LIMIT ? (
          <button type="button" className="home-more" onClick={() => setExpanded(!expanded)}>
            {hidden > 0 ? `展开其余 ${hidden} 条` : "收起"}
          </button>
        ) : null
      }
    >
      {visible.map((item) => {
        const { thread } = item;
        const turn = item.activity?.lastTurn;
        const tone = turn ? turnTone(turn.status) : "info";
        const Icon = turn ? RESULT_ICONS[turnTone(turn.status)] : MessageSquareText;
        const detail = unseenDetail(item);
        return (
          <Row
            key={item.key}
            thread={item.thread}
            project={projectOf.get(item.key)}
            tone={tone}
            lead={<Icon />}
            time={relativeTime(finishedAt(item))}
            detail={<span className="home-row-reply">{detail}</span>}
            title={`${thread.name}\n${detail}`}
            onOpen={() => onOpen(thread)}
            action={
              <button
                type="button"
                className="home-row-done"
                title="标为已读"
                aria-label={`将 ${thread.name} 标为已读`}
                onClick={() => onMarkSeen(item.key)}
              >
                <Check />
              </button>
            }
          />
        );
      })}
    </Panel>
  );
}

function RunningPanel({
  items,
  projectOf,
  onOpen,
}: {
  items: RunningItem[];
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const now = useNow(1_000);
  return (
    <Panel id="home-running" tone="running" Icon={Play} title="运行中" count={items.length}>
      {items.map((item) => {
        const { thread, activity, stalled } = item;
        const step = activity?.step;
        let detail: ReactNode;
        if (stalled != null)
          detail = (
            <>
              <TriangleAlert aria-hidden="true" />
              <b>疑似卡住</b>
              <span>已 {formatDuration(stalled)} 没有新事件</span>
            </>
          );
        else if (thread.compacting)
          detail = (
            <>
              <Minimize2 aria-hidden="true" />
              <b>压缩上下文</b>
            </>
          );
        else if (step) {
          const described = describeStep(step.item, thread.cwd);
          const StepIcon = STEP_ICONS[described.kind];
          detail = (
            <>
              <StepIcon aria-hidden="true" />
              <b>{described.label}</b>
              {described.target ? <code>{described.target}</code> : null}
              <span className="home-step-time">{formatElapsed(now - step.startedAt)}</span>
            </>
          );
        } else
          detail = (
            <>
              <Brain aria-hidden="true" />
              <b>{activity ? "等待模型" : "运行中"}</b>
            </>
          );
        return (
          <Row
            key={item.key}
            thread={item.thread}
            project={projectOf.get(item.key)}
            tone={stalled != null ? "stall" : "run"}
            lead={<i className="home-dot" />}
            time={formatElapsed(now - item.startedAt)}
            timeTitle="本轮已运行"
            detail={<span className="home-row-step">{detail}</span>}
            onOpen={() => onOpen(thread)}
          />
        );
      })}
    </Panel>
  );
}

function RecentPanel({
  items,
  projectOf,
  onOpen,
  onShowAll,
}: {
  items: HomeItem[];
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
  onShowAll: () => void;
}) {
  return (
    <Panel
      id="home-recent"
      tone="recent"
      Icon={Clock3}
      title="最近会话"
      footer={
        <button type="button" className="home-more home-more-all" onClick={onShowAll}>
          查看全部会话
        </button>
      }
    >
      {items.map((item) => {
        const { thread } = item;
        // 只在知道上一轮回复时多一行；preview 多是标题或占位文案，不重复展示。
        const detail = replyPreview(item.activity?.lastTurn?.reply);
        return (
          <Row
            key={item.key}
            thread={item.thread}
            project={projectOf.get(item.key)}
            tone="idle"
            lead={<i className="home-dot" />}
            time={relativeTime(thread.updatedAt)}
            detail={detail ? <span className="home-row-reply">{detail}</span> : undefined}
            onOpen={() => onOpen(thread)}
          />
        );
      })}
    </Panel>
  );
}

function watchDetail(watcher: WakeWatcher) {
  const how =
    watcher.mode === "poll"
      ? `${everyLabel(watcher.intervalSec ?? 60)}检查`
      : "等待命令结束";
  return (
    <span className="home-row-step">
      <b>{watcher.label}</b>
      <span>{how}</span>
      {watcher.state ? <code>{watcher.state}</code> : null}
      {watcher.failures ? (
        <em className="home-row-warn">连接失败 {watcher.failures}/10</em>
      ) : null}
    </span>
  );
}

/** 本机 deck-wake watcher：远端任务结束时会唤醒对应会话。 */
function WatchPanel({
  watchers,
  threadOf,
  projectOf,
  onOpen,
}: {
  watchers: WakeWatcher[];
  threadOf: ReadonlyMap<string, ThreadSummary>;
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const now = useNow(30_000);
  // 连接出问题的排前面，其余按启动先后，顺序稳定。
  const sorted = [...watchers].sort(
    (a, b) => Number(Boolean(b.failures)) - Number(Boolean(a.failures)),
  );
  return (
    <Panel id="home-watch" tone="watch" Icon={Radar} title="deck-wake 监督中" count={watchers.length}>
      {sorted.length ? null : (
        <li className="home-empty">
          <b>没有正在监督的远端任务</b>
          <span>让 agent 用 deck-wake 挂上 watcher，远端任务结束时会自动唤醒会话。</span>
        </li>
      )}
      {sorted.map((watcher) => {
        const thread = watcher.threadId
          ? threadOf.get(activityKey(watcher.agentId, watcher.threadId))
          : undefined;
        const title = [
          `${watcher.label} · 代号 ${watcher.code} · pid ${watcher.pid}`,
          watcher.state && watcher.stateAt
            ? `状态 ${watcher.state}（${relativeTime(watcher.stateAt)}）`
            : "",
          `$ ${watcher.command}`,
          watcher.log ? `日志 ${watcher.log}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <Row
            key={watcher.pid}
            thread={thread}
            name={thread ? undefined : `代号 ${watcher.code}（未绑定会话）`}
            project={thread ? projectOf.get(sessionKey(thread)) : undefined}
            tone={watcher.failures ? "watch warn" : "watch"}
            lead={<Radar />}
            time={roughly("已盯", now - watcher.startedAt)}
            timeTitle={`启动于 ${new Date(watcher.startedAt).toLocaleString("zh-CN")}`}
            detail={watchDetail(watcher)}
            title={title}
            onOpen={thread ? () => onOpen(thread) : undefined}
            menu={false}
            action={
              <button
                type="button"
                className="home-row-done"
                title="停止这个 watcher（不会再唤醒会话）"
                aria-label={`停止 watcher ${watcher.label}`}
                onClick={() => {
                  if (window.confirm(`停止 watcher「${watcher.label}」？远端任务不受影响，但结束时不会再唤醒会话。`))
                    post(`/monitor/watchers/${watcher.pid}/stop`).catch(() => {});
                }}
              >
                <Square />
              </button>
            }
          />
        );
      })}
    </Panel>
  );
}

/**
 * 首页主栏：默认按“球在谁手里”排——需要你处理的、agent 交回来的新回复、
 * 还在跑的、其余最近会话，最后是 deck-wake 盯着的远端任务；用户可在「调整布局」里改顺序。
 * 审批卡片由外层放在最上方。「监督中」常驻，其余面板没内容时不显示。
 */
export function MonitorBoard({
  order,
  threads,
  activities,
  approvalsByThread,
  unseenSessions,
  deliveries,
  watchers,
  lostWatchers = [],
  projectOf,
  onOpen,
  onMarkSeen,
  onMarkAllSeen,
  onSessionMenu,
  onShowAll,
}: {
  /** 面板顺序（本机保存）。 */
  order: readonly MainPanelId[];
  threads: ThreadSummary[];
  activities: ReadonlyMap<string, ThreadActivity>;
  approvalsByThread: ReadonlyMap<string, Approval[]>;
  unseenSessions: ReadonlySet<string>;
  /** 唤醒投递队列里需要人看的条目：dead 或仍在重试且已失败过的。 */
  deliveries: WakeDelivery[];
  /** 快照下发的 watcher 列表，首轮轮询落地前先靠它展示。 */
  watchers?: WakeWatcher[];
  /** 失联待处理的 watcher。 */
  lostWatchers?: LostWakeWatcher[];
  projectOf: ReadonlyMap<string, ProjectGroup>;
  onOpen: (thread: ThreadSummary) => void;
  onMarkSeen: (key: string) => void;
  onMarkAllSeen: () => void;
  onSessionMenu?: (thread: ThreadSummary) => void;
  onShowAll: () => void;
}) {
  // 5 秒一档足够判定“疑似卡住”；秒表由运行中面板自己订阅。
  const now = useNow(5_000);
  const watched = useWakeWatchers(watchers);
  const threadOf = useMemo(
    () => new Map(threads.map((thread) => [activityKey(thread.agentId, thread.id), thread])),
    [threads],
  );
  const visibleDeliveries = useMemo(
    () =>
      deliveries.filter(
        (delivery) =>
          delivery.status === "dead" ||
          (delivery.status === "pending" && delivery.attempts > 0),
      ),
    [deliveries],
  );
  const supervised = useMemo(
    () =>
      new Set(
        watched.flatMap((watcher) =>
          watcher.threadId ? [activityKey(watcher.agentId, watcher.threadId)] : [],
        ),
      ),
    [watched],
  );
  const board = useMemo(
    () =>
      buildHomeBoard({
        threads,
        activities,
        pendingOf: (thread) => approvalsByThread.get(sessionKey(thread)),
        unseenSessions,
        supervised,
        now,
        recentLimit: RECENT_LIMIT,
      }),
    [threads, activities, approvalsByThread, unseenSessions, supervised, now],
  );
  const panel = (id: MainPanelId): ReactNode => {
    switch (id) {
      case "attention":
        return board.attention.length ||
          visibleDeliveries.length ||
          lostWatchers.length ? (
          <AttentionPanel
            items={board.attention}
            deliveries={visibleDeliveries}
            lost={lostWatchers}
            threadOf={threadOf}
            projectOf={projectOf}
            onOpen={onOpen}
          />
        ) : null;
      case "unseen":
        return board.unseen.length ? (
          <UnseenPanel
            items={board.unseen}
            projectOf={projectOf}
            onOpen={onOpen}
            onMarkSeen={onMarkSeen}
            onMarkAllSeen={onMarkAllSeen}
          />
        ) : null;
      case "running":
        return board.running.length ? (
          <RunningPanel items={board.running} projectOf={projectOf} onOpen={onOpen} />
        ) : null;
      case "recent":
        return board.recent.length ? (
          <RecentPanel
            items={board.recent}
            projectOf={projectOf}
            onOpen={onOpen}
            onShowAll={onShowAll}
          />
        ) : null;
      case "watch":
        // 常驻：没有 watcher 时显示空态，一眼就知道当前没有远端任务被盯着。
        return (
          <WatchPanel
            watchers={watched}
            threadOf={threadOf}
            projectOf={projectOf}
            onOpen={onOpen}
          />
        );
    }
  };
  return (
    <RowMenuContext.Provider value={onSessionMenu}>
      {order.map((id) => (
        <Fragment key={id}>{panel(id)}</Fragment>
      ))}
    </RowMenuContext.Provider>
  );
}
