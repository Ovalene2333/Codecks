import { useLayoutEffect, useRef } from "react";
import { Folder, GitBranch } from "lucide-react";
import type { ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";
import { AssistantMarkdown } from "./markdown";
import { TurnBlock } from "./TurnBlock";
import type { PendingUserMessage } from "./optimistic";
import type { StreamedAgentMessage } from "./streaming";
import { activeStreamItemId } from "./streaming";

export function Timeline({
  thread,
  turns,
  streamed,
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
  const hasActiveTurn = turns.some(
    (turn) =>
      turn?.id === thread.activeTurnId ||
      turn?.status === "inProgress" ||
      turn?.status === "running",
  );
  const streamingItemId = activeStreamItemId(streamed);
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
          (thread.status === "running" || thread.status === "waiting") && (
            <div className="message agent streaming" role="status">
              正在准备响应…
              <i />
            </div>
          )}
        {!hasActiveTurn && streamed.length > 0 && (
          <section className="turn-block active live-turn">
            {streamed.map((message) => (
              <div
                className={`message agent ${message.itemId === streamingItemId ? "streaming" : ""}`}
                key={message.itemId}
              >
                <AssistantMarkdown text={message.text} onCopy={onCopy} />
                {message.itemId === streamingItemId && <i />}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
