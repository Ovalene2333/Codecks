import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldAlert,
  X,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { ApprovalCard } from "../session/ApprovalCard";
import { threadForApproval } from "../session/approvals";
import type { Approval, ApprovalResolveBody, ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";

export function ApprovalInbox({
  approvals,
  threads,
  notificationPermission,
  onRequestNotifications,
  onOpenThread,
  onResolve,
}: {
  approvals: Approval[];
  threads: ThreadSummary[];
  notificationPermission: DeckNotificationPermission;
  onRequestNotifications: () => void;
  onOpenThread: (thread: ThreadSummary) => void;
  onResolve: (id: string, body: ApprovalResolveBody) => void;
}) {
  const [activeId, setActiveId] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [resolvingId, setResolvingId] = useState<string>();
  const previousCount = useRef(approvals.length);
  const activeIndex = Math.max(
    0,
    approvals.findIndex((approval) => approval.id === activeId),
  );
  const active = approvals[activeIndex] || approvals[0];
  const thread = active ? threadForApproval(active, threads) : undefined;

  useEffect(() => {
    if (approvals.length > previousCount.current) setCollapsed(false);
    previousCount.current = approvals.length;
    if (activeId && approvals.some((approval) => approval.id === activeId))
      return;
    setActiveId(approvals[0]?.id);
  }, [activeId, approvals]);

  if (!active) return null;

  const move = (offset: number) => {
    const index = (activeIndex + offset + approvals.length) % approvals.length;
    setActiveId(approvals[index].id);
  };
  const resolve = async (id: string, body: ApprovalResolveBody) => {
    if (resolvingId) return;
    setResolvingId(id);
    try {
      await onResolve(id, body);
    } finally {
      setResolvingId(undefined);
    }
  };

  if (collapsed)
    return (
      <button
        type="button"
        className="approval-inbox-trigger"
        onClick={() => setCollapsed(false)}
        aria-label={`展开 ${approvals.length} 条待审批请求`}
      >
        <ShieldAlert aria-hidden="true" />
        <span>待审批</span>
        <b>{approvals.length}</b>
      </button>
    );

  return (
    <aside
      className="approval-inbox"
      aria-label="全局审批"
      aria-live="assertive"
    >
      <div className="approval-inbox-handle" aria-hidden="true" />
      <header className="approval-inbox-header">
        <span className="approval-inbox-symbol" aria-hidden="true">
          <ShieldAlert />
        </span>
        <b>需要确认</b>
        {approvals.length > 1 ? (
          <nav aria-label="切换待审批请求">
            <span>
              {activeIndex + 1} / {approvals.length}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => move(-1)}
              aria-label="上一条审批"
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => move(1)}
              aria-label="下一条审批"
            >
              <ChevronRight />
            </button>
          </nav>
        ) : null}
        <button
          type="button"
          className="icon-btn approval-inbox-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="收起审批浮窗"
        >
          <X />
        </button>
      </header>

      {thread ? (
        <button
          type="button"
          className="approval-session-link"
          onClick={() => onOpenThread(thread)}
        >
          <span>
            <small>Session</small>
            <b>{thread.name}</b>
          </span>
          <ExternalLink aria-hidden="true" />
        </button>
      ) : null}

      <RenderErrorBoundary
        resetKey={active.id}
        fallback={<p className="error-banner">这条审批无法显示</p>}
      >
        <ApprovalCard
          approval={active}
          onResolve={resolve}
          disabled={resolvingId === active.id}
        />
      </RenderErrorBoundary>

      {notificationPermission === "default" ? (
        <button
          type="button"
          className="approval-notification-opt-in"
          onClick={onRequestNotifications}
        >
          <BellRing aria-hidden="true" />
          开启系统提醒
        </button>
      ) : null}
    </aside>
  );
}
