import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Folder, GitBranch } from "lucide-react";
import type { ThreadSummary, MessageDelivery } from "../types";
import { Empty } from "../kit";
import { RenderErrorBoundary } from "../ui";
import { OperationStatus } from "./OperationStatus";
import { OptimisticUserMessage, TurnBlock } from "./TurnBlock";
import { MessageQueue } from "./MessageQueue";
import { basename } from "../format";
import type { PendingUserMessage } from "./optimistic";
import { reconcileTimelineMessages } from "./timeline-messages";
import type { LoadedUserMessage } from "./user-message-reconcile";
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
const EMPTY_DELIVERIES: MessageDelivery[] = [];

export function Timeline({
  thread,
  turns,
  olderTurns,
  loading,
  streamed,
  streamedItems,
  streamedEntries,
  turnProgress,
  onExpandTurn,
  pendingUsers: pendingMessages,
  messageDeliveries: deliveryRecords = EMPTY_DELIVERIES,
  deliveryHistoryBefore,
  onDeliveryCancel,
  onDeliveryRetry,
  onDeliveryFeedback,
  feedbackInterrupts,
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
  loading?: boolean;
  /** 长会话分页：还有更早的轮没加载时展示顶部按钮，点击追加。 */
  olderTurns?: {
    remaining?: number;
    loading: boolean;
    onLoadMore: () => void;
  };
  streamed: StreamedAgentMessage[];
  streamedItems: StreamedTurnItem[];
  streamedEntries: StreamedEntry[];
  /** 本会话活跃回合的最新 turn/progress（底部状态块实时 TPS 用）。 */
  turnProgress?: {
    turnId?: string;
    outputTokens?: number;
    elapsedMs?: number;
  };
  /** 展开被折叠的回合工具输出（按 turn 粒度懒加载全文）。 */
  onExpandTurn?: (turnId: string) => void;
  pendingUsers: PendingUserMessage[];
  messageDeliveries?: MessageDelivery[];
  deliveryHistoryBefore?: ReadonlyMap<string, LoadedUserMessage[]>;
  onDeliveryCancel?: (id: string) => Promise<void>;
  onDeliveryRetry?: (id: string) => Promise<void>;
  onDeliveryFeedback?: (id: string) => Promise<void>;
  feedbackInterrupts?: boolean;
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
  const pendingDeliveryIds = useRef(new Set<string>());
  const reconciled = useMemo(() => reconcileTimelineMessages(
    thread, turns, streamedItems, pendingMessages, deliveryRecords, deliveryHistoryBefore,
    pendingDeliveryIds.current,
  ), [thread, turns, streamedItems, pendingMessages, deliveryRecords, deliveryHistoryBefore]);
  const syncedDeliveryIds = useRef(new Set<string>());
  const pendingUsers = reconciled.pendingUsers;
  const messageDeliveries = useMemo(() => reconciled.messageDeliveries.filter(
    (item) => !syncedDeliveryIds.current.has(item.id),
  ), [reconciled.messageDeliveries]);
  useEffect(() => {
    const visibleIds = new Set(reconciled.messageDeliveries.map((item) => item.id));
    // 正文已接管的气泡不因回退/编辑历史再次出现在底部。
    for (const item of deliveryRecords) {
      if (item.agentId !== (thread.agentId || "codex") || item.threadId !== thread.id) continue;
      if (["queued", "interrupting", "sending"].includes(item.status)) pendingDeliveryIds.current.add(item.id);
      if (item.status === "delivered" && !visibleIds.has(item.id) &&
        (pendingDeliveryIds.current.has(item.id) || deliveryHistoryBefore?.has(item.id) ||
          (item.turnId && item.turnId === thread.activeTurnId))) syncedDeliveryIds.current.add(item.id);
    }
  }, [reconciled, deliveryRecords, deliveryHistoryBefore, thread.agentId, thread.id, thread.activeTurnId]);
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  /**
   * 距底距离（scrollHeight - scrollTop - clientHeight），滚动位置的唯一真相。
   * 不用绝对 scrollTop 恢复：上方内容高度一变（图片加载、折叠展开、流式
   * 落定、追加更早轮），绝对值恢复必跳；按“离底多远”锚定，底部追加与
   * 顶部前插都自然稳定。
   */
  const bottomGap = useRef(0);
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
    // 时间线常驻滚动条槽位；把槽宽交给同列的输入框/审批条，两者左右缘
    // 才能与轨道对齐（覆盖式滚动条为 0）。
    const syncGutter = () =>
      element.parentElement?.style.setProperty(
        "--scrollbar-gutter",
        `${Math.max(0, element.offsetWidth - element.clientWidth)}px`,
      );
    syncGutter();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncGutter();
      if (element.clientHeight === viewportHeight.current) return;
      viewportHeight.current = element.clientHeight;
      // 输入框换行/虚拟键盘会改变消息区高度。贴底继续贴底；
      // 阅读历史时按底隙重锚定，不抢位置。
      if (followOutput.current) {
        element.scrollTop = element.scrollHeight;
        bottomGap.current = 0;
      } else {
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight - bottomGap.current,
        );
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
          bottomGap.current = Math.max(
            0,
            element.scrollHeight - element.scrollTop - element.clientHeight,
          );
          return;
        }
      }

      if (activeThread.current !== thread.id) {
        activeThread.current = thread.id;
        followOutput.current = true;
        element.scrollTop = element.scrollHeight;
        bottomGap.current = 0;
        return;
      }

      if (followOutput.current) {
        element.scrollTop = element.scrollHeight;
        bottomGap.current = 0;
      } else {
        // 阅读历史：按底隙锚定。底部追加新轮不影响上方位置；
        // 上方高度变化（图片/展开/前插更早轮）时视图保持离底距离，不跳。
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight - bottomGap.current,
        );
      }
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
    messageDeliveries,
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
        bottomGap.current = 0;
        return;
      }
    }
    bottomGap.current = Math.max(
      0,
      element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    followOutput.current = bottomGap.current < 80;
  };
  const activeTurnIndex = turns.findIndex(
    (turn) =>
      turn?.id === thread.activeTurnId ||
      turn?.status === "inProgress" ||
      turn?.status === "running",
  );
  const hasActiveTurn = activeTurnIndex >= 0;
  const isEmpty = !turns.length && !pendingUsers.length && !streamed.length && !messageDeliveries.length;
  // 只在首次加载落定后展示 hero，避免缓存/请求在途时空态闪现后被内容替换。
  const showEmpty = isEmpty && targetFallbackReady === true;
  return (
    <div className="timeline" ref={timeline} onScroll={rememberScrollPosition}>
      {loading && <div className="timeline-loading">
        <OperationStatus title="正在加载会话" detail="正在读取历史记录，请稍候。"
          slowDetail="历史记录较多，仍在加载。你可以先浏览其他会话。" />
        <div className="timeline-loading-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
      </div>}
      {olderTurns && (
        <button
          type="button"
          className="timeline-load-more"
          onClick={olderTurns.onLoadMore}
          disabled={olderTurns.loading}
          aria-busy={olderTurns.loading}
        >
          {olderTurns.loading
            ? "正在加载更早消息…"
            : olderTurns.remaining ? `加载更早的 ${olderTurns.remaining} 轮` : "加载更早消息"}
        </button>
      )}
      {showEmpty ? (
        <Empty
          title={`在 ${basename(thread.cwd) || thread.name} 开始`}
          desc="描述你的任务，或选一个起点。"
          action={
            onQuickPrompt ? (
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
            ) : null
          }
        />
      ) : (
        <div className="session-meta">
          <Folder />
          <span className="session-meta-cwd" title={thread.cwd || undefined}>
            {thread.cwd}
          </span>
          {thread.resolvedModel || thread.model ? (
            <span className="session-meta-model">
              {thread.resolvedModel || thread.model}
            </span>
          ) : null}
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
        {(Array.isArray(turns) ? turns : []).map((turn, index) => {
          const turnIdStr = String(turn?.id || "");
          const isActiveTurn = thread.activeTurnId
            ? turnIdStr === String(thread.activeTurnId)
            : index === (Array.isArray(turns) ? turns : []).length - 1;
          return (
          <RenderErrorBoundary
            key={turn?.id || index}
            resetKey={turnIdStr || String(index)}
            fallback={
              <section className="turn-block">
                <div className="rail-row rail-row--meta">第 {index + 1} 轮无法显示</div>
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
              turnProgress={isActiveTurn ? turnProgress : undefined}
              onCopy={onCopy}
              onForkFrom={onForkFrom}
              onEditUserMessage={onEditUserMessage}
              onRetryUserMessage={onRetryUserMessage}
              onRevertUserMessage={onRevertUserMessage}
              onExpandTurn={onExpandTurn}
              messageActionsDisabled={messageActionsDisabled}
              autoFoldProcess={index < turns.length - 1}
            />
          </RenderErrorBoundary>
          );
        })}
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
              <OptimisticUserMessage message={message} />
            </section>
          ))}
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
              onExpandTurn={onExpandTurn}
              messageActionsDisabled={messageActionsDisabled}
              turnProgress={turnProgress}
            />
          )}
        <MessageQueue
          items={messageDeliveries}
          onCancel={onDeliveryCancel}
          onRetry={onDeliveryRetry}
          onFeedback={onDeliveryFeedback}
          feedbackInterrupts={feedbackInterrupts}
        />
      </div>
    </div>
  );
}
