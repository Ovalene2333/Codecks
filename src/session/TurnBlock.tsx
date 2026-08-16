import { Fragment } from "react";
import {
  Activity,
  BookOpenText,
  Command,
  Files,
  FolderSearch,
  GitFork,
  Pencil,
  RotateCcw,
  ScanSearch,
  Wrench,
} from "lucide-react";
import { displayCommand, displayText, fmtTime } from "../format";
import type { FileChange, ThreadSummary } from "../types";
import { FileDiff } from "./FileDiff";
import { AssistantMarkdown } from "./markdown";
import { userImageParts } from "./images";
import type {
  StreamedAgentMessage,
  StreamedTurnItem,
} from "./streaming";
import {
  activeStreamItemId,
  mergeTurnItems,
  streamsCoveredByHistory,
} from "./streaming";
import { userMessageText } from "./user-message";
import {
  commandPresentation,
  fileChangeGroupLabel,
  groupTurnItems,
  toolCallPresentation,
  turnReadTargets,
} from "./turn-items";

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
    const presentation = commandPresentation(item, cwd);
    const semantic = presentation.kind !== "command";
    const detail = [
      semantic && command ? `$ ${command}` : "",
      displayText(item.aggregatedOutput),
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <details
        className={`tool-row command-row ${presentation.kind}-row ${state}`}
      >
        <summary>
          {presentation.kind === "read" ? (
            <BookOpenText />
          ) : presentation.kind === "explore" ? (
            <FolderSearch />
          ) : (
            <Command />
          )}
          <span className={`tool-action ${presentation.kind}`}>
            {presentation.label ||
              (item.status === "inProgress" ? "正在执行" : "已执行")}
          </span>
          <code className="tool-command" title={presentation.target || command}>
            {presentation.target || command}
          </code>
        </summary>
        {detail ? <pre>{detail}</pre> : null}
      </details>
    );
  }
  if (item.type === "fileChange")
    return (
      <FileDiff changes={item.changes as FileChange[] | undefined} cwd={cwd} />
    );
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const { tool, scope, input, output } = toolCallPresentation(item);
    const state =
      item.status === "inProgress"
        ? "running"
        : item.status === "failed" || item.error || item.success === false
          ? "failed"
          : "ok";
    const detail = [
      input ? `Input\n${input}` : "",
      output ? `Output\n${output}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <details className={`tool-row tool-call-row ${state}`}>
        <summary>
          <Wrench />
          <span className="tool-action">{tool}</span>
          {scope ? (
            <code className="tool-command" title={scope}>
              {scope}
            </code>
          ) : null}
        </summary>
        {detail ? <pre>{detail}</pre> : null}
      </details>
    );
  }
  return <UnknownItem item={item} />;
}

function FileChangeGroup({
  items,
  changes,
  cwd,
}: {
  items: any[];
  changes: FileChange[];
  cwd?: string;
}) {
  const label = fileChangeGroupLabel(changes);
  const state = items.some((item) => item?.status === "failed")
    ? "failed"
    : items.some((item) => item?.status === "inProgress")
      ? "running"
      : "ok";
  return (
    <details className={`tool-row file-change-group ${state}`}>
      <summary>
        <Files />
        <span className={`tool-action ${label}`}>{label}</span>
        <span className="file-change-count">{changes.length} 个文件</span>
      </summary>
      <div className="file-change-group-content">
        <FileDiff changes={changes} cwd={cwd} />
      </div>
    </details>
  );
}

function ReadSummary({ targets }: { targets: string[] }) {
  if (targets.length === 0) return null;
  return (
    <details className="tool-row read-summary">
      <summary>
        <BookOpenText />
        <span className="tool-action read">本轮已读取</span>
        <strong>{targets.length} 个文件</strong>
        <code className="tool-command" title={targets.join("、")}>
          {targets.join("、")}
        </code>
      </summary>
      <ul>
        {targets.map((target) => (
          <li key={target}>
            <code>{target}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TurnBlock({
  turn,
  index,
  thread,
  highlighted,
  targetItemId,
  targetRequest,
  streamed,
  streamedItems = [],
  onCopy,
  onForkFrom,
  onEditUserMessage,
  onRetryUserMessage,
  messageActionsDisabled,
}: {
  turn: any;
  index: number;
  thread: ThreadSummary;
  highlighted?: boolean;
  targetItemId?: string;
  targetRequest?: number;
  streamed: StreamedAgentMessage[];
  streamedItems?: StreamedTurnItem[];
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
  const historyItems = Array.isArray(turn.items) ? turn.items : [];
  const turnItems = active
    ? mergeTurnItems(historyItems, streamedItems)
    : historyItems;
  const renderEntries = groupTurnItems(turnItems);
  const readTargets = turnReadTargets(turnItems, thread.cwd);
  const streamedByItem = new Map(
    active ? streamed.map((message) => [message.itemId, message.text]) : [],
  );
  const streamingItemId = active ? activeStreamItemId(streamed) : undefined;
  const renderedStreamIds = active
    ? streamsCoveredByHistory(turnItems, streamed)
    : new Set<string>();
  const started =
    Date.parse(turn.startedAt || turn.createdAt || turn.updatedAt || "") ||
    thread.updatedAt;
  return (
    <section
      className={`turn-block ${active ? "active" : ""} ${highlighted ? "search-target" : ""}`}
      data-turn-id={turn?.id ? String(turn.id) : undefined}
    >
      <header className="turn-head">
        Turn {index} · {fmtTime(started)}
        {turn.model || thread.model ? ` · ${turn.model || thread.model}` : ""}
        {thread.reasoningEffort ? ` · ${thread.reasoningEffort}` : ""}
      </header>
      <ReadSummary targets={readTargets} />
      {renderEntries.map((entry, itemIndex) => {
        if (entry.kind === "fileChangeGroup")
          return (
            <FileChangeGroup
              key={`file-group-${entry.items[0]?.id || itemIndex}`}
              items={entry.items}
              changes={entry.changes as FileChange[]}
              cwd={thread.cwd}
            />
          );
        const item = entry.item;
        const liveText =
          item.type === "agentMessage" && item.id
            ? streamedByItem.get(String(item.id))
            : undefined;
        if (liveText !== undefined) renderedStreamIds.add(String(item.id));
        const itemKey = item.id || `${item.type}-${item.command || itemIndex}`;
        const targeted = Boolean(
          targetItemId && String(item.id) === targetItemId,
        );
        const content = (
          <TurnItem
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
        return targeted ? (
          <div
            key={`${itemKey}:search:${targetRequest}`}
            className="search-item-target"
            data-item-id={item.id ? String(item.id) : undefined}
          >
            {content}
          </div>
        ) : (
          <Fragment key={itemKey}>{content}</Fragment>
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
