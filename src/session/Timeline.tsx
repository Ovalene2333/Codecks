import { useLayoutEffect, useRef } from "react";
import { Folder, GitBranch, LoaderCircle } from "lucide-react";
import type { ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";
import { TurnBlock } from "./TurnBlock";
import type { PendingUserMessage } from "./optimistic";
import type { StreamedAgentMessage, StreamedTurnItem } from "./streaming";

export function Timeline({
  thread,
  turns,
  streamed,
  streamedItems,
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
  messageActionsDisabled,
}: {
  thread: ThreadSummary;
  turns: any[];
  streamed: StreamedAgentMessage[];
  streamedItems: StreamedTurnItem[];
  pendingUsers: PendingUserMessage[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  targetTurnId?: string;
  targetItemId?: string;
  targetRequest?: number;
  targetFallbackReady?: boolean;
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
  onOpenOrigin?: () => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (turnId: string, item: any) => void;
  messageActionsDisabled?: boolean;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const scrollTop = useRef(0);
  const activeThread = useRef(thread.id);
  const appliedTargetRequest = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;

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
        target.scrollIntoView({ block: "center" });
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
  }, [
    thread.id,
    turns,
    streamed,
    targetTurnId,
    targetItemId,
    targetRequest,
    targetFallbackReady,
  ]);

  const rememberScrollPosition = () => {
    const element = timeline.current;
    if (!element) return;
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
  return (
    <div className="timeline" ref={timeline} onScroll={rememberScrollPosition}>
      <div className="session-meta">
        <Folder />
        {thread.cwd}
        <span>{thread.model}</span>
      </div>
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
              onCopy={onCopy}
              onForkFrom={onForkFrom}
              onEditUserMessage={onEditUserMessage}
              onRetryUserMessage={onRetryUserMessage}
              messageActionsDisabled={messageActionsDisabled}
            />
          </RenderErrorBoundary>
        ))}
        {pendingUsers.map((message) => (
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
        {!hasActiveTurn && (streamed.length > 0 || streamedItems.length > 0) && (
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
            onCopy={onCopy}
            onEditUserMessage={onEditUserMessage}
            onRetryUserMessage={onRetryUserMessage}
            messageActionsDisabled={messageActionsDisabled}
          />
        )}
      </div>
    </div>
  );
}
