import { useLayoutEffect, useRef } from "react";
import { Folder, GitBranch, LoaderCircle } from "lucide-react";
import type { ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";
import { TurnBlock } from "./TurnBlock";
import { basename } from "../format";
import type { PendingUserMessage } from "./optimistic";
import type {
  StreamedAgentMessage,
  StreamedEntry,
  StreamedTurnItem,
} from "./streaming";

const QUICK_PROMPTS = [
  { label: "项目概览", text: "这个项目是做什么的？先给我一个概览" },
  { label: "代码结构", text: "帮我梳理一下代码结构" },
  { label: "Git 改动", text: "检查当前 git 状态和最近的改动" },
];

export function Timeline({
  thread,
  turns,
  streamed,
  streamedItems,
  streamedEntries,
  pendingUsers,
  origin,
  targetTurnId,
  targetItemId,
  targetRequest,
  targetFallbackReady,
  onCopy,
  onForkFrom,
  onOpenOrigin,
  onEditUserMessage,
  onRetryUserMessage,
  onRevertUserMessage,
  onQuickPrompt,
  messageActionsDisabled,
}: {
  thread: ThreadSummary;
  turns: any[];
  streamed: StreamedAgentMessage[];
  streamedItems: StreamedTurnItem[];
  streamedEntries: StreamedEntry[];
  pendingUsers: PendingUserMessage[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  targetTurnId?: string;
  targetItemId?: string;
  targetRequest?: number;
  targetFallbackReady?: boolean;
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
  onOpenOrigin?: () => void;
  onEditUserMessage?: (turnId: string, item: any) => void;
  onRetryUserMessage?: (turnId: string, item: any) => void;
  onRevertUserMessage?: (turnId: string, item: any) => void;
  onQuickPrompt?: (text: string) => void;
  messageActionsDisabled?: boolean;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const scrollTop = useRef(0);
  const viewportHeight = useRef(0);
  const activeThread = useRef(thread.id);
  const appliedTargetRequest = useRef<number | undefined>(undefined);
  // 流式 delta 逐 token 触发本 effect：读写 scrollTop 是同步布局操作，
  // 用 rAF 把同帧多次触发合并成一次，避免打字机式布局抖动。
  const pendingFrame = useRef(0);

  useLayoutEffect(() => {
    if (typeof cancelAnimationFrame !== "function") return;
    return () => cancelAnimationFrame(pendingFrame.current);
  }, []);

  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    viewportHeight.current = element.clientHeight;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight === viewportHeight.current) return;
      viewportHeight.current = element.clientHeight;
      // 输入框换行/收起设置会改变消息区高度。只在原本贴底时继续贴底，
      // 手动阅读历史时不抢走当前位置。
      if (followOutput.current) {
        element.scrollTop = element.scrollHeight;
        scrollTop.current = element.scrollTop;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    const apply = () => {
      pendingFrame.current = 0;
      if (
        targetRequest !== undefined &&
        appliedTargetRequest.current !== targetRequest
      ) {
        const itemTarget = targetItemId
          ? Array.from(
              element.querySelectorAll<HTMLElement>("[data-item-id]"),
            ).find((item) => item.dataset.itemId === targetItemId)
          : undefined;
        const turnTarget =
          targetTurnId && (!targetItemId || targetFallbackReady)
            ? Array.from(
                element.querySelectorAll<HTMLElement>("[data-turn-id]"),
              ).find((item) => item.dataset.turnId === targetTurnId)
            : undefined;
        const target = itemTarget || turnTarget;
        if (target) {
          appliedTargetRequest.current = targetRequest;
          activeThread.current = thread.id;
          followOutput.current = false;
          const viewport = element.getBoundingClientRect();
          const item = target.getBoundingClientRect();
          element.scrollTop +=
            item.top - viewport.top - (element.clientHeight - item.height) / 2;
          scrollTop.current = element.scrollTop;
          return;
        }
      }

      if (activeThread.current !== thread.id) {
        activeThread.current = thread.id;
        followOutput.current = true;
        element.scrollTop = element.scrollHeight;
        scrollTop.current = element.scrollTop;
        return;
      }

      if (followOutput.current) element.scrollTop = element.scrollHeight;
      else element.scrollTop = scrollTop.current;
      scrollTop.current = element.scrollTop;
    };
    // 同帧多次 effect 只保留最后一次滚动应用；切会话/跳目标等首帧即生效，
    // rAF 回调在下次绘制前执行，无可感知延迟。无 rAF 环境（单测/SSR）直接执行。
    if (typeof requestAnimationFrame !== "function") {
      apply();
    } else {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = requestAnimationFrame(apply);
    }
  }, [
    thread.id,
    turns,
    streamed,
    streamedItems,
    pendingUsers,
    targetTurnId,
    targetItemId,
    targetRequest,
    targetFallbackReady,
  ]);

  const rememberScrollPosition = () => {
    const element = timeline.current;
    if (!element) return;
    if (element.clientHeight !== viewportHeight.current) {
      viewportHeight.current = element.clientHeight;
      if (followOutput.current) {
        element.scrollTop = element.scrollHeight;
        scrollTop.current = element.scrollTop;
        return;
      }
    }
    scrollTop.current = element.scrollTop;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    followOutput.current = distanceFromBottom < 80;
  };
  const activeTurnIndex = turns.findIndex(
    (turn) =>
      turn?.id === thread.activeTurnId ||
      turn?.status === "inProgress" ||
      turn?.status === "running",
  );
  const hasActiveTurn = activeTurnIndex >= 0;
  const isEmpty = !turns.length && !pendingUsers.length && !streamed.length;
  // 只在首次加载落定后展示 hero，避免缓存/请求在途时空态闪现后被内容替换。
  const showEmpty = isEmpty && targetFallbackReady === true;
  return (
    <div className="timeline" ref={timeline} onScroll={rememberScrollPosition}>
      {showEmpty ? (
        <div className="session-empty">
          <h3>在 {basename(thread.cwd) || thread.name} 开始</h3>
          <p className="session-empty-lead">描述你的任务，或选一个起点。</p>
          {onQuickPrompt ? (
            <div className="session-empty-prompts">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt.text}
                  type="button"
                  onClick={() => onQuickPrompt(prompt.text)}
                  title={prompt.text}
                >
                  {prompt.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="session-meta">
          <Folder />
          {thread.cwd}
          <span>{thread.resolvedModel || thread.model}</span>
        </div>
      )}
      {origin && (
        <button type="button" className="origin-chip" onClick={onOpenOrigin}>
          <GitBranch />
          从《{origin.name}》{origin.turnLabel || "截取分支"}
          {origin.archived ? "（已归档）" : ""}
        </button>
      )}
      <div className="timeline-turns">
        {(Array.isArray(turns) ? turns : []).map((turn, index) => (
          <RenderErrorBoundary
            key={turn?.id || index}
            resetKey={String(turn?.id || index)}
            fallback={
              <section className="turn-block">
                <header className="turn-head">Turn {index + 1} 无法显示</header>
              </section>
            }
          >
            <TurnBlock
              turn={turn}
              index={index + 1}
              thread={thread}
              highlighted={Boolean(
                targetTurnId &&
                (!targetItemId ||
                  !(Array.isArray(turn?.items) ? turn.items : []).some(
                    (item: any) => String(item?.id) === targetItemId,
                  )) &&
                String(turn?.id) === targetTurnId,
              )}
              targetItemId={targetItemId}
              targetRequest={targetRequest}
              streamed={streamed}
              streamedItems={index === activeTurnIndex ? streamedItems : []}
              streamedEntries={index === activeTurnIndex ? streamedEntries : []}
              pendingUsers={pendingUsers.filter(
                (message) => message.turnId === String(turn?.id || ""),
              )}
              onCopy={onCopy}
              onForkFrom={onForkFrom}
              onEditUserMessage={onEditUserMessage}
              onRetryUserMessage={onRetryUserMessage}
              onRevertUserMessage={onRevertUserMessage}
              messageActionsDisabled={messageActionsDisabled}
            />
          </RenderErrorBoundary>
        ))}
        {pendingUsers
          .filter(
            (message) =>
              !message.turnId ||
              (!turns.some(
                (turn) => String(turn?.id || "") === message.turnId,
              ) &&
                !(
                  !hasActiveTurn &&
                  (streamed.length > 0 || streamedItems.length > 0) &&
                  message.turnId === String(thread.activeTurnId || "")
                )),
          )
          .map((message) => (
            <section className="turn-block optimistic-turn" key={message.id}>
              <header className="turn-head">正在发送</header>
              <div className="message user">
                {message.images.length > 0 && (
                  <div className="message-images">
                    {message.images.map((image) => (
                      <img key={image.id} src={image.url} alt={image.name} />
                    ))}
                  </div>
                )}
                {message.text}
              </div>
            </section>
          ))}
        {streamed.length === 0 &&
          streamedItems.length === 0 &&
          (thread.status === "running" || thread.status === "waiting") && (
            <div className="message agent response-pending" role="status">
              <span className="response-pending-spinner" aria-hidden="true">
                <LoaderCircle />
              </span>
              <span>正在等待响应</span>
            </div>
          )}
        {!hasActiveTurn &&
          (streamed.length > 0 || streamedItems.length > 0) && (
            <TurnBlock
              turn={{
                id: thread.activeTurnId,
                status: "inProgress",
                items: [],
              }}
              index={turns.length + 1}
              thread={thread}
              streamed={streamed}
              streamedItems={streamedItems}
              streamedEntries={streamedEntries}
              pendingUsers={pendingUsers.filter(
                (message) =>
                  message.turnId === String(thread.activeTurnId || ""),
              )}
              onCopy={onCopy}
              onEditUserMessage={onEditUserMessage}
              onRetryUserMessage={onRetryUserMessage}
              onRevertUserMessage={onRevertUserMessage}
              messageActionsDisabled={messageActionsDisabled}
            />
          )}
      </div>
    </div>
  );
}
