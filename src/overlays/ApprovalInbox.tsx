import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldAlert,
  X,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { ApprovalCard, type ApprovalDraft } from "../session/ApprovalCard";
import { threadForApproval } from "../session/approvals";
import type { Approval, ApprovalResolveBody, ThreadSummary } from "../types";
import { RenderErrorBoundary, useOverlayHistory } from "../ui";

function MobileApprovalHistory({ onClose }: { onClose: () => void }) {
  useOverlayHistory(onClose);
  return null;
}

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
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const [resolvingId, setResolvingId] = useState<string>();
  const resolvingRef = useRef(false);
  const [resolveError, setResolveError] = useState<{
    id: string;
    message: string;
  }>();
  const [drafts, setDrafts] = useState<Record<string, ApprovalDraft>>({});
  const previousCount = useRef(approvals.length);
  const lastIndex = useRef(0);
  const scrollPositions = useRef<Record<string, number>>({});
  const inboxRef = useRef<HTMLElement>(null);
  const found = approvals.findIndex((approval) => approval.id === activeId);
  const activeIndex =
    found >= 0 ? found : Math.min(lastIndex.current, approvals.length - 1);
  const active = approvals[activeIndex];
  const thread = active ? threadForApproval(active, threads) : undefined;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (previousCount.current === 0 && approvals.length > 0)
      setCollapsed(false);
    previousCount.current = approvals.length;
    if (active) {
      lastIndex.current = activeIndex;
      if (active.id !== activeId) setActiveId(active.id);
    }
  }, [active, activeId, activeIndex, approvals.length]);

  useLayoutEffect(() => {
    if (!active || collapsed) return;
    const content =
      inboxRef.current?.querySelector<HTMLElement>(".approval-content");
    if (content) content.scrollTop = scrollPositions.current[active.id] || 0;
  }, [active?.id, collapsed]);

  useEffect(() => {
    if (collapsed || !active) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      inboxRef.current?.style.setProperty(
        "--approval-visual-inset",
        `${inset}px`,
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active?.id, collapsed]);

  useEffect(() => {
    if (collapsed || !active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCollapsed(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active?.id, collapsed]);

  useEffect(() => {
    const pending = new Set(approvals.map((approval) => approval.id));
    setDrafts((current) => {
      if (Object.keys(current).every((id) => pending.has(id))) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([id]) => pending.has(id)),
      );
    });
    for (const id of Object.keys(scrollPositions.current)) {
      if (!pending.has(id)) delete scrollPositions.current[id];
    }
  }, [approvals]);

  if (!active) return null;

  const move = (offset: number) => {
    if (resolvingRef.current) return;
    const index = (activeIndex + offset + approvals.length) % approvals.length;
    lastIndex.current = index;
    setActiveId(approvals[index].id);
  };
  const resolve = async (id: string, body: ApprovalResolveBody) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolvingId(id);
    setResolveError(undefined);
    try {
      await onResolve(id, body);
    } catch (error) {
      setResolveError({
        id,
        message:
          error instanceof Error ? error.message : "审批处理失败，请重试",
      });
    } finally {
      resolvingRef.current = false;
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
    <>
      {mobile ? (
        <MobileApprovalHistory onClose={() => setCollapsed(true)} />
      ) : null}
      <div
        className="approval-inbox-backdrop"
        onClick={() => setCollapsed(true)}
      />
      <aside
        ref={inboxRef}
        className="approval-inbox"
        aria-label="全局审批"
        onScrollCapture={(event) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.classList.contains("approval-content")
          )
            scrollPositions.current[active.id] = target.scrollTop;
        }}
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
                disabled={Boolean(resolvingId)}
                onClick={() => move(-1)}
                aria-label="上一条审批"
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={Boolean(resolvingId)}
                onClick={() => move(1)}
                aria-label="下一条审批"
              >
                <ChevronRight />
              </button>
            </nav>
          ) : null}
          {notificationPermission === "default" ? (
            <button
              type="button"
              className="icon-btn approval-inbox-notifications"
              onClick={onRequestNotifications}
              aria-label="开启系统提醒"
              title="开启系统提醒"
            >
              <BellRing aria-hidden="true" />
            </button>
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
            onClick={() => {
              setCollapsed(true);
              onOpenThread(thread);
            }}
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
            error={
              resolveError?.id === active.id ? resolveError.message : undefined
            }
            draft={drafts[active.id]}
            onDraftChange={(draft) =>
              setDrafts((current) => ({ ...current, [active.id]: draft }))
            }
          />
        </RenderErrorBoundary>
      </aside>
    </>
  );
}
