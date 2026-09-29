import type { ReactNode } from "react";
import {
  BookOpenText,
  Bot,
  Brain,
  CircleAlert,
  Clock3,
  Command,
  FolderSearch,
  Globe,
  Hourglass,
  MessageSquareText,
  Minimize2,
  Pencil,
  ShieldAlert,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { sessionKey } from "../format";
import type { ProjectGroup } from "../projects";
import { approvalPreview } from "../session/approvals";
import { TileCard } from "../tiled/TiledStage";
import type {
  Approval,
  ApprovalResolveBody,
  Provider,
  SessionSearchMatch,
  ThreadActivity,
  ThreadSummary,
} from "../types";
import {
  contextPercent,
  contextTone,
  describeStep,
  formatDuration,
  formatElapsed,
  stalledFor,
  turnResultLabel,
  turnStartedAt,
  type StepKind,
} from "./activity";
import { useNow } from "./activity-store";

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

function firstLine(text?: string) {
  return (text || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

/** 卡片底部的实时条：现在在做什么、做了多久、是否卡住、上下文余量。 */
function LiveStrip({
  thread,
  activity,
  pending,
  onFocusApproval,
}: {
  thread: ThreadSummary;
  activity?: ThreadActivity;
  pending: Approval[];
  onFocusApproval: (id: string) => void;
}) {
  const now = useNow();
  const started = turnStartedAt(thread, activity);
  const stalled = stalledFor(thread, activity, now);
  const context = contextPercent(thread.tokenUsage);
  const step = activity?.step;
  let main: ReactNode = null;

  if (pending.length) {
    const approval = pending[0];
    main = (
      <button
        type="button"
        className="monitor-live-line wait"
        onClick={(event) => {
          event.stopPropagation();
          onFocusApproval(approval.id);
        }}
        title="在审批队列中处理"
      >
        <ShieldAlert aria-hidden="true" />
        <span className="monitor-live-label">等待审批</span>
        <code>
          {approvalPreview(approval)}
          {pending.length > 1 ? ` 等 ${pending.length} 项` : ""}
        </code>
      </button>
    );
  } else if (thread.status === "waiting") {
    main = (
      <div className="monitor-live-line wait">
        <Hourglass aria-hidden="true" />
        <span className="monitor-live-label">等待输入</span>
      </div>
    );
  } else if (thread.status === "error") {
    main = (
      <div className="monitor-live-line danger" title={thread.lastError}>
        <CircleAlert aria-hidden="true" />
        <span className="monitor-live-label">出错</span>
        <code>{firstLine(thread.lastError) || thread.errorCode || "任务失败"}</code>
      </div>
    );
  } else if (started != null) {
    const described = thread.compacting
      ? { kind: "compact" as const, label: "压缩上下文", target: "" }
      : step
        ? describeStep(step.item, thread.cwd)
        : // 没有活动记录（旧服务端或刚启动）时不知道在做什么，不能断言在等模型。
          { kind: "think" as const, label: activity ? "等待模型" : "运行中", target: "" };
    const Icon = STEP_ICONS[described.kind];
    main = (
      <div className={`monitor-live-line run kind-${described.kind}`}>
        <Icon aria-hidden="true" />
        <span className="monitor-live-label">{described.label}</span>
        {described.target ? (
          <code title={described.target}>{described.target}</code>
        ) : null}
        {step ? (
          <time className="monitor-live-step">{formatElapsed(now - step.startedAt)}</time>
        ) : null}
      </div>
    );
  } else if (activity?.lastTurn) {
    const { startedAt, endedAt, status } = activity.lastTurn;
    main = (
      <div className={`monitor-live-line idle ${status === "failed" ? "danger" : ""}`}>
        <Clock3 aria-hidden="true" />
        <span className="monitor-live-label">上一轮</span>
        <span className="monitor-live-text">
          {formatDuration(endedAt - startedAt)} · {turnResultLabel(status)}
        </span>
      </div>
    );
  }

  const meta = [
    started != null ? (
      <span key="turn">
        本轮 <b>{formatElapsed(now - started)}</b>
      </span>
    ) : null,
    context != null ? (
      <span key="context" className={`monitor-live-context ${contextTone(context)}`}>
        上下文
        <i aria-hidden="true">
          <b style={{ width: `${context}%` }} />
        </i>
        <b>{context}%</b>
      </span>
    ) : null,
  ].filter(Boolean);

  if (!main && !meta.length && stalled == null) return null;
  return (
    <div className={`monitor-live ${stalled != null ? "stalled" : ""}`}>
      {main}
      {stalled != null ? (
        <div className="monitor-live-line stall" role="status">
          <TriangleAlert aria-hidden="true" />
          <span className="monitor-live-label">疑似卡住</span>
          <span className="monitor-live-text">已 {formatDuration(stalled)} 没有新事件</span>
        </div>
      ) : null}
      {meta.length ? <div className="monitor-live-meta">{meta}</div> : null}
    </div>
  );
}

export function MonitorCard({
  thread,
  activity,
  selected,
  unseen,
  project,
  pending,
  providers,
  forkCount,
  searchMatch,
  query,
  onSelect,
  onSessionMenu,
  onHistory,
  onResolveApproval,
  onFocusApproval,
}: {
  thread: ThreadSummary;
  activity?: ThreadActivity;
  selected?: string;
  unseen: boolean;
  project?: ProjectGroup;
  pending: Approval[];
  providers: Provider[];
  forkCount: number;
  searchMatch?: SessionSearchMatch;
  query: string;
  onSelect: (thread: ThreadSummary, match?: SessionSearchMatch) => void;
  onSessionMenu: (thread: ThreadSummary) => void;
  onHistory: (thread: ThreadSummary) => void;
  onResolveApproval: (id: string, body: ApprovalResolveBody) => void;
  onFocusApproval: (id: string) => void;
}) {
  const key = sessionKey(thread);
  const status = thread.compacting ? "running" : thread.status;
  return (
    <div
      className={`monitor-node status-${status} ${pending.length ? "needs-input" : ""} ${unseen ? "unseen" : ""} ${key === selected ? "current" : ""}`}
    >
      {/* 审批统一交给顶部队列处理，卡片里不再重复一套批准/拒绝按钮。 */}
      <TileCard
        thread={thread}
        current={key === selected}
        project={project}
        unseen={unseen}
        pending={[]}
        providers={providers}
        forkCount={forkCount}
        searchMatch={searchMatch}
        searchQuery={query}
        onSelect={() => onSelect(thread, searchMatch)}
        onSessionMenu={() => onSessionMenu(thread)}
        onHistory={() => onHistory(thread)}
        onResolveApproval={onResolveApproval}
      />
      <LiveStrip
        thread={thread}
        activity={activity}
        pending={pending}
        onFocusApproval={onFocusApproval}
      />
    </div>
  );
}
