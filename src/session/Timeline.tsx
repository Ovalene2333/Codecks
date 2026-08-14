import { useLayoutEffect, useRef } from "react";
import { Folder, GitBranch } from "lucide-react";
import type { Approval, ApprovalResolveBody, ThreadSummary } from "../types";
import { RenderErrorBoundary } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
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
  approvals,
  origin,
  onResolve,
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
  approvals: Approval[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  onResolve: (id: string, body: ApprovalResolveBody) => void;
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

  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;

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
  }, [thread.id, turns, streamed, approvals.length]);

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
      <div className="timeline-approvals">
        {approvals.map((approval) => (
          <RenderErrorBoundary
            key={approval.id}
            resetKey={approval.id}
            fallback={<p className="error-banner">这条审批无法显示</p>}
          >
            <ApprovalCard approval={approval} onResolve={onResolve} />
          </RenderErrorBoundary>
        ))}
      </div>
    </div>
  );
}
