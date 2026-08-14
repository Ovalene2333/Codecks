import {
  Activity,
  Command,
  GitFork,
  Pencil,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import { displayCommand, displayText, fmtTime } from "../format";
import type { FileChange, ThreadSummary } from "../types";
import { FileDiff } from "./FileDiff";
import { AssistantMarkdown } from "./markdown";
import { userImageParts } from "./images";
import type { StreamedAgentMessage } from "./streaming";
import { activeStreamItemId } from "./streaming";
import { userMessageText } from "./user-message";

export const userText = userMessageText;

function UnknownItem({ item }: { item: any }) {
  let raw = "";
  try {
    raw = JSON.stringify(item, null, 2) || "";
  } catch {
    raw = String(item?.type || "unknown");
  }
  return (
    <details className="unknown-item">
      <summary>{item?.type || "unknown"}</summary>
      <pre>{raw}</pre>
    </details>
  );
}

function TurnItem({
  item,
  streamed,
  streaming,
  cwd,
  onCopy,
  onEditUserMessage,
  onRetryUserMessage,
  messageActionsDisabled,
}: {
  item: any;
  streamed?: string;
  streaming?: boolean;
  cwd?: string;
  onCopy?: () => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (item: any) => void;
  messageActionsDisabled?: boolean;
}) {
  if (item.type === "userMessage") {
    const images = userImageParts(item);
    const text = userText(item);
    return (
      <div className="user-message-wrap">
        <div className="message user">
          {images.length > 0 && (
            <div className="message-images">
              {images.map((image, index) =>
                image.url.startsWith("data:image/") ||
                image.url.startsWith("blob:") ||
                /^https?:/i.test(image.url) ? (
                  <img
                    key={`${image.url}-${index}`}
                    src={image.url}
                    alt={image.alt || "图片"}
                  />
                ) : (
                  <span key={`${image.url}-${index}`} className="local-image">
                    {image.alt || image.url}
                  </span>
                ),
              )}
            </div>
          )}
          {text}
        </div>
        {(onEditUserMessage || onRetryUserMessage) && (
          <div className="message-actions" aria-label="消息操作">
            {onEditUserMessage && (
              <button
                type="button"
                title="编辑后重发"
                onClick={() => onEditUserMessage(item)}
              >
                <Pencil />
                编辑
              </button>
            )}
            {onRetryUserMessage && (
              <button
                type="button"
                title="从此处创建分支并重试"
                disabled={messageActionsDisabled}
                onClick={() => onRetryUserMessage(item)}
              >
                <RotateCcw />
                从此重试
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  if (item.type === "enteredReviewMode")
    return (
      <div className="tool-row review-row">
        <ScanSearch />
        正在审查 {displayText(item.review) || "当前改动"}
      </div>
    );
  if (item.type === "exitedReviewMode")
    return (
      <div className="tool-row review-row done">
        <ScanSearch />
        审查完成
      </div>
    );
  if (item.type === "agentMessage") {
    return (
      <div className={`message agent ${streaming ? "streaming" : ""}`}>
        <AssistantMarkdown
          text={streamed !== undefined ? streamed : displayText(item.text)}
          onCopy={onCopy}
        />
        {streaming && <i />}
      </div>
    );
  }
  if (item.type === "reasoning")
    return (
      <details className="tool-row reasoning">
        <summary>
          <Activity />
          思考过程
        </summary>
        <div>
          {displayText(item.summary) || displayText(item.content) || ""}
        </div>
      </details>
    );
  if (item.type === "commandExecution") {
    const state =
      item.status === "inProgress"
        ? "running"
        : item.status === "failed"
          ? "failed"
          : "ok";
    const command = displayCommand(displayText(item.command));
    return (
      <details className={`tool-row command-row ${state}`}>
        <summary>
          <Command />
          <span className="tool-status">
            {item.status === "inProgress" ? "正在执行" : "已执行"}
          </span>
          <code className="tool-command" title={command}>
            {command}
          </code>
        </summary>
        {displayText(item.aggregatedOutput) ? (
          <pre>{displayText(item.aggregatedOutput)}</pre>
        ) : null}
      </details>
    );
  }
  if (item.type === "fileChange")
    return (
      <FileDiff changes={item.changes as FileChange[] | undefined} cwd={cwd} />
    );
  return <UnknownItem item={item} />;
}

export function TurnBlock({
  turn,
  index,
  thread,
  streamed,
  onCopy,
  onForkFrom,
  onEditUserMessage,
  onRetryUserMessage,
  messageActionsDisabled,
}: {
  turn: any;
  index: number;
  thread: ThreadSummary;
  streamed: StreamedAgentMessage[];
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (turnId: string, item: any) => void;
  messageActionsDisabled?: boolean;
}) {
  const active =
    turn.id === thread.activeTurnId ||
    turn.status === "inProgress" ||
    turn.status === "running";
  const completed = !active && turn.status !== "running";
  const streamedByItem = new Map(
    active ? streamed.map((message) => [message.itemId, message.text]) : [],
  );
  const streamingItemId = active ? activeStreamItemId(streamed) : undefined;
  const renderedStreamIds = new Set<string>();
  const started =
    Date.parse(turn.startedAt || turn.createdAt || turn.updatedAt || "") ||
    thread.updatedAt;
  return (
    <section className={`turn-block ${active ? "active" : ""}`}>
      <header className="turn-head">
        Turn {index} · {fmtTime(started)}
        {turn.model || thread.model ? ` · ${turn.model || thread.model}` : ""}
        {thread.reasoningEffort ? ` · ${thread.reasoningEffort}` : ""}
      </header>
      {(Array.isArray(turn.items) ? turn.items : []).map((item: any) => {
        const liveText =
          item.type === "agentMessage" && item.id
            ? streamedByItem.get(String(item.id))
            : undefined;
        if (liveText !== undefined) renderedStreamIds.add(String(item.id));
        return (
          <TurnItem
            key={item.id || `${item.type}-${item.command || ""}`}
            item={item}
            streamed={liveText}
            streaming={String(item.id) === streamingItemId}
            cwd={thread.cwd}
            onCopy={onCopy}
            onEditUserMessage={onEditUserMessage}
            onRetryUserMessage={
              onRetryUserMessage
                ? (item) => onRetryUserMessage(String(turn.id), item)
                : undefined
            }
            messageActionsDisabled={messageActionsDisabled}
          />
        );
      })}
      {active &&
        streamed
          .filter((message) => !renderedStreamIds.has(message.itemId))
          .map((message) => (
            <div
              className={`message agent ${message.itemId === streamingItemId ? "streaming" : ""}`}
              key={message.itemId}
            >
              <AssistantMarkdown text={message.text} onCopy={onCopy} />
              {message.itemId === streamingItemId && <i />}
            </div>
          ))}
      {completed && turn.id && onForkFrom && (
        <button
          type="button"
          className="fork-from-turn"
          onClick={() => onForkFrom(turn.id)}
        >
          <GitFork />
          从此处分支
        </button>
      )}
    </section>
  );
}
