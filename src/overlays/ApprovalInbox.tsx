import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BellRing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  ShieldAlert,
} from "lucide-react";
import type { DeckNotificationPermission } from "../notifications";
import { ApprovalCard } from "../session/ApprovalCard";
import { threadForApproval } from "../session/approvals";
import { useApprovalQueue } from "../session/approvalQueue";
import type { Approval, ApprovalResolveBody, ThreadSummary } from "../types";
import { RenderErrorBoundary, useOverlayHistory } from "../ui";

function MobileApprovalHistory({ onClose }: { onClose: () => void }) {
  useOverlayHistory(onClose);
  return null;
}

/** 拖动浮窗时留一点边距，避免标题或操作按钮贴死在视口边缘。 */
function clampToViewport(x: number, y: number, width: number, height: number) {
  const margin = 8;
  return {
    x: Math.min(
      Math.max(margin, x),
      Math.max(margin, window.innerWidth - width - margin),
    ),
    y: Math.min(
      Math.max(margin, y),
      Math.max(margin, window.innerHeight - height - margin),
    ),
  };
}

/**
 * 全局审批浮窗：所有会话（含当前会话）的待审批都在这里。
 * - 新一批审批的第一条默认展开，处理后依次显示下一条；手动收起保留到本批结束。
 * - 桌面收起时保留标题栏并可点击展开，手机显示「待审批 n」按钮。
 * - 桌面两种状态共用拖动手柄与位置，位置限制在视口内。
 */
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
  const queue = useApprovalQueue(approvals, onResolve);
  const { active, activeIndex } = queue;
  const [expanded, setExpanded] = useState(() => approvals.length > 0);
  const hadPendingApprovals = useRef(approvals.length > 0);
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const scrollPositions = useRef<Record<string, number>>({});
  const inboxRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const dragState = useRef<
    | {
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        width: number;
        height: number;
      }
    | undefined
  >(undefined);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragFrame = useRef<number | undefined>(undefined);
  const dragPending = useRef<{ x: number; y: number } | undefined>(undefined);
  const thread = active ? threadForApproval(active, threads) : undefined;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!active || !position || mobile) return;
    const clamp = () => {
      const element = inboxRef.current;
      if (!element || dragState.current) return;
      const rect = element.getBoundingClientRect();
      setPosition((current) => {
        if (!current) return current;
        const next = clampToViewport(
          current.x,
          current.y,
          rect.width,
          rect.height,
        );
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    if (inboxRef.current) observer.observe(inboxRef.current);
    window.addEventListener("resize", clamp);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [expanded, position, mobile, active?.id]);

  useEffect(
    () => () => {
      if (dragFrame.current !== undefined)
        cancelAnimationFrame(dragFrame.current);
    },
    [],
  );

  /**
   * 拖动只更新 transform，并合并到一帧一次；pointermove 不再触发 React
   * 渲染，松开时才把最终位置写回 state。
   */
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || dragState.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const element = inboxRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
    };
    dragOffset.current = { x: 0, y: 0 };
    // 先切到 left/top，再叠加 transform，避免第一帧从右上角跳过来。
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.willChange = "transform";
    element.classList.add("is-dragging");
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const next = clampToViewport(
      state.originX + event.clientX - state.startX,
      state.originY + event.clientY - state.startY,
      state.width,
      state.height,
    );
    dragOffset.current = {
      x: next.x - state.originX,
      y: next.y - state.originY,
    };
    dragPending.current = dragOffset.current;
    if (dragFrame.current === undefined)
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = undefined;
        const element = inboxRef.current;
        const offset = dragPending.current;
        if (!element || !offset) return;
        element.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
      });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (dragFrame.current !== undefined) {
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = undefined;
    }
    dragPending.current = undefined;
    const offset = dragOffset.current;
    const next = clampToViewport(
      state.originX + offset.x,
      state.originY + offset.y,
      state.width,
      state.height,
    );
    dragState.current = undefined;
    dragOffset.current = { x: 0, y: 0 };
    const element = inboxRef.current;
    if (element) {
      element.style.left = `${next.x}px`;
      element.style.top = `${next.y}px`;
      element.style.transform = "";
      element.style.willChange = "";
      element.classList.remove("is-dragging");
    }
    setPosition(next);
  };

  // 只在队列由空变为非空时自动展开，不打断同一批请求内的手动收起。
  useEffect(() => {
    if (!approvals.length) setExpanded(false);
    else if (!hadPendingApprovals.current) setExpanded(true);
    hadPendingApprovals.current = approvals.length > 0;
    const pending = new Set(approvals.map((approval) => approval.id));
    for (const id of Object.keys(scrollPositions.current))
      if (!pending.has(id)) delete scrollPositions.current[id];
  }, [approvals]);

  useLayoutEffect(() => {
    if (!active || !expanded) return;
    const content =
      inboxRef.current?.querySelector<HTMLElement>(".approval-content");
    if (content) content.scrollTop = scrollPositions.current[active.id] || 0;
  }, [active?.id, expanded]);

  useEffect(() => {
    if (!expanded || !active) return;
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
  }, [active?.id, expanded]);

  useEffect(() => {
    if (!expanded || !active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active?.id, expanded]);

  if (!active) return null;
  const count = approvals.length;
  const sessionName = thread?.name || "其他会话";

  const toggleExpanded = () => {
    // 首次切换也保留当前左上角，避免从内容较短的标题栏跳回默认锚点。
    if (!mobile && inboxRef.current) {
      const rect = inboxRef.current.getBoundingClientRect();
      setPosition({ x: rect.left, y: rect.top });
    }
    setExpanded((value) => !value);
  };

  if (!expanded && mobile)
    return (
      <button
        type="button"
        className="approval-inbox-trigger"
        onClick={() => setExpanded(true)}
        aria-label={`展开 ${count} 条待审批请求`}
      >
        <ShieldAlert aria-hidden="true" />
        <span>待审批</span>
        <b>{count}</b>
      </button>
    );

  return (
    <>
      {mobile ? (
        <MobileApprovalHistory onClose={() => setExpanded(false)} />
      ) : null}
      <div
        className="approval-inbox-backdrop"
        onClick={() => setExpanded(false)}
      />
      <aside
        ref={inboxRef}
        className={`approval-inbox${expanded ? "" : " is-collapsed"}`}
        aria-label="全局审批"
        style={
          !mobile && position
            ? {
                left: position.x,
                top: position.y,
                right: "auto",
                bottom: "auto",
              }
            : undefined
        }
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
        <header
          className="approval-inbox-header"
          onClick={(event) => {
            if (
              !expanded &&
              event.target instanceof Element &&
              !event.target.closest("button, .approval-drag-grip")
            )
              toggleExpanded();
          }}
        >
          <span
            className="approval-drag-grip"
            aria-hidden="true"
            title="拖动审批浮窗"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          >
            <GripVertical />
          </span>
          <span className="approval-inbox-symbol" aria-hidden="true">
            <ShieldAlert />
          </span>
          <b className="approval-inbox-session" title={sessionName}>
            {expanded ? "待审批" : sessionName}
          </b>
          {count > 1 ? (
            <nav aria-label="切换待审批请求">
              <span>
                {activeIndex + 1} / {count}
              </span>
              <button
                type="button"
                className="icon-btn"
                disabled={Boolean(queue.resolvingId)}
                onClick={() => queue.move(-1)}
                aria-label="上一条审批"
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={Boolean(queue.resolvingId)}
                onClick={() => queue.move(1)}
                aria-label="下一条审批"
              >
                <ChevronRight />
              </button>
            </nav>
          ) : null}
          {expanded && queue.bulkTargets.length > 1 ? (
            <button
              type="button"
              className="approval-inbox-bulk"
              disabled={queue.busy}
              onClick={() => void queue.resolveAll()}
              aria-label={`全部允许其余 ${queue.bulkTargets.length} 条权限请求`}
              title={`本会话内始终允许其余 ${queue.bulkTargets.length} 条权限请求；问答类需逐条处理`}
            >
              {queue.bulkBusy ? "正在允许…" : "全部允许"}
            </button>
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
            onClick={toggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? "收起审批浮窗" : "展开审批浮窗"}
            title={expanded ? "收起" : "展开"}
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </button>
        </header>

        {expanded && queue.bulkError ? (
          <p className="error-banner approval-inbox-error" role="alert">
            {queue.bulkError}
          </p>
        ) : null}

        {expanded ? (
          <RenderErrorBoundary
            resetKey={active.id}
            fallback={<p className="error-banner">这条审批无法显示</p>}
          >
            <ApprovalCard
              key={active.id}
              approval={active}
              onResolve={queue.resolve}
              disabled={queue.resolvingId === active.id}
              error={queue.errorFor(active.id)}
              draft={queue.draftFor(active.id)}
              onDraftChange={(draft) => queue.setDraft(active.id, draft)}
              contextCwd={thread?.cwd}
              session={
                thread
                  ? {
                      name: thread.name,
                      cwd: thread.cwd,
                      onOpen: () => {
                        setExpanded(false);
                        onOpenThread(thread);
                      },
                    }
                  : undefined
              }
            />
          </RenderErrorBoundary>
        ) : null}
      </aside>
    </>
  );
}
