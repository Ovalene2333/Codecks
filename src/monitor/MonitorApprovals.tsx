import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { ApprovalCard } from "../session/ApprovalCard";
import { threadForApproval } from "../session/approvals";
import type { Approval, ApprovalResolveBody, ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";

const SWIPE_PX = 60;

function typingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.closest?.("input, textarea, select, [contenteditable='true']"),
  );
}

/**
 * 监控台的审批队列：一次一条，←/→ 或左右滑动切换；处理完停在同一位置，
 * 下一条自动顶上来，不回到第一条。不提供批量批准——每条都该被看一眼。
 */
export function MonitorApprovals({
  approvals,
  threads,
  activeId,
  onActiveChange,
  notificationPermission,
  onRequestNotifications,
  onOpenThread,
  onResolve,
}: {
  approvals: Approval[];
  threads: ThreadSummary[];
  activeId?: string;
  onActiveChange: (id: string) => void;
  notificationPermission: DeckNotificationPermission;
  onRequestNotifications: () => void;
  onOpenThread: (thread: ThreadSummary) => void;
  onResolve: (id: string, body: ApprovalResolveBody) => void | Promise<void>;
}) {
  const [resolvingId, setResolvingId] = useState<string>();
  const lastIndex = useRef(0);
  const swipe = useRef<{ x: number; y: number } | undefined>(undefined);
  const found = approvals.findIndex((approval) => approval.id === activeId);
  const index =
    found >= 0 ? found : Math.min(lastIndex.current, approvals.length - 1);
  const active = approvals[index];
  const thread = active ? threadForApproval(active, threads) : undefined;

  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
    if (active && active.id !== activeId) onActiveChange(active.id);
  }, [active, activeId, index, onActiveChange]);

  const move = (offset: number) => {
    if (approvals.length < 2) return;
    const next = (index + offset + approvals.length) % approvals.length;
    onActiveChange(approvals[next].id);
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      if (typingTarget(event.target)) return;
      if (event.key === "ArrowLeft") moveRef.current(-1);
      else if (event.key === "ArrowRight") moveRef.current(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!active) return null;

  const resolve = async (id: string, body: ApprovalResolveBody) => {
    if (resolvingId) return;
    setResolvingId(id);
    try {
      await onResolve(id, body);
    } finally {
      setResolvingId(undefined);
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch")
      swipe.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = undefined;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 2)
      move(dx < 0 ? 1 : -1);
  };

  return (
    <section
      id="monitor-approvals"
      className="monitor-panel monitor-approvals"
      aria-label="待处理审批"
    >
      <header className="monitor-panel-head">
        <ShieldAlert aria-hidden="true" />
        <h2>待处理审批</h2>
        <b className="monitor-count">{approvals.length}</b>
        {approvals.length > 1 ? (
          <nav className="monitor-approvals-nav" aria-label="切换审批">
            <button
              type="button"
              className="icon-btn"
              onClick={() => move(-1)}
              aria-label="上一条审批"
              title="上一条（←）"
            >
              <ChevronLeft />
            </button>
            <span>
              {index + 1} / {approvals.length}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => move(1)}
              aria-label="下一条审批"
              title="下一条（→）"
            >
              <ChevronRight />
            </button>
          </nav>
        ) : null}
      </header>
      <div
        className="monitor-approvals-body"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = undefined)}
        aria-live="polite"
      >
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
            key={active.id}
            approval={active}
            onResolve={resolve}
            disabled={resolvingId === active.id}
          />
        </RenderErrorBoundary>
      </div>
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
    </section>
  );
}
