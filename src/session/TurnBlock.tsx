import { Fragment, memo } from "react";
import {
  Activity,
  BookOpenText,
  Bot,
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
import { AssistantMarkdown, DeferredImage } from "./markdown";
import { assistantImageParts, userImageParts } from "./images";
import type { StreamedAgentMessage, StreamedTurnItem } from "./streaming";
import {
  activeStreamItemId,
  mergeTurnItems,
  streamsCoveredByHistory,
} from "./streaming";
import { userMessageText } from "./user-message";
import type { PendingUserMessage } from "./optimistic";
import {
  commandPresentation,
  fileChangeGroupLabel,
  groupTurnItems,
  reasoningText,
  toolCallPresentation,
  turnReadTargets,
} from "./turn-items";
import { uiAdapterFor } from "./adapters";

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

function TurnItemInner({
  item,
  streamed,
  streaming,
  cwd,
  onCopy,
  onEditUserMessage,
  onRetryUserMessage,
  messageActionsDisabled,
  thread,
}: {
  item: any;
  streamed?: string;
  streaming?: boolean;
  cwd?: string;
  onCopy?: () => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (item: any) => void;
  messageActionsDisabled?: boolean;
  thread: ThreadSummary;
}) {
  // Per-agent adapters get first pick at items they understand (extension
  // payloads, agent-specific tool shapes); everything else falls through to
  // the shared Codex-shaped renderers below.
  const adapted = uiAdapterFor(thread.agentId)?.renderItem?.(item, { thread });
  if (adapted !== undefined) return adapted;
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
    const images = assistantImageParts(item);
    return (
      <div className={`message agent ${streaming ? "streaming" : ""}`}>
        <AssistantMarkdown
          text={streamed !== undefined ? streamed : displayText(item.text)}
          onCopy={onCopy}
        />
        {images.length > 0 && (
          <div className="message-images assistant-images">
            {images.map((image, index) => (
              <DeferredImage
                key={`${image.url}-${index}`}
                src={image.url}
                alt={image.alt || "生成或引用的图片"}
                thread={thread}
              />
            ))}
          </div>
        )}
        {streaming && <i />}
      </div>
    );
  }
  const standaloneImages = assistantImageParts(item);
  if (standaloneImages.length > 0)
    return (
      <div className="message agent image-message">
        <div className="message-images assistant-images">
          {standaloneImages.map((image, index) => (
            <DeferredImage
              key={`${image.url}-${index}`}
              src={image.url}
              alt={image.alt || "生成或引用的图片"}
              thread={thread}
            />
          ))}
        </div>
      </div>
    );
  if (item.type === "reasoning")
    return (
      <details className="tool-row reasoning">
        <summary>
          <Activity />
          思考过程
        </summary>
        <div>{reasoningText(item)}</div>
      </details>
    );
  if (item.type === "subagent") {
    const state =
      item.status === "inProgress"
        ? "running"
        : item.status === "failed"
          ? "failed"
          : "ok";
    const title = displayText(item.title) || "子代理";
    const agent = displayText(item.agent);
    const activity = displayText(item.activity);
    const output = displayText(item.aggregatedOutput);
    return (
      <div className={`tool-row subagent-row ${state}`}>
        <details>
          <summary>
            <Bot />
            <span className="tool-action">
              {state === "running"
                ? "子代理执行中"
                : state === "failed"
                  ? "子代理失败"
                  : "子代理"}
            </span>
            <code className="tool-command" title={title}>
              {title}
            </code>
            {agent ? (
              <span className="subagent-agent" title={agent}>
                {agent}
              </span>
            ) : null}
          </summary>
          {output ? <pre>{output}</pre> : null}
        </details>
        {state === "running" && activity ? (
          <div className="subagent-activity" title={activity}>
            {activity}
          </div>
        ) : null}
      </div>
    );
  }
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

// 历史 item 对象引用稳定时可跳过重渲染；streamed/streaming/cwd 变化仍正常更新。
// 回调多为父级内联箭头但语义稳定，默认浅比较已能过滤大部分无关重渲染。
const TurnItem = memo(TurnItemInner);

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

function OptimisticUserMessage({ message }: { message: PendingUserMessage }) {
  return (
    <div className="user-message-wrap optimistic-user-message">
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
    </div>
  );
}

interface TurnBlockProps {
  turn: any;
  index: number;
  thread: ThreadSummary;
  highlighted?: boolean;
  targetItemId?: string;
  targetRequest?: number;
  streamed: StreamedAgentMessage[];
  streamedItems?: StreamedTurnItem[];
  pendingUsers?: PendingUserMessage[];
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (turnId: string, item: any) => void;
  messageActionsDisabled?: boolean;
}

// Timeline 把全量 streamed/streamedItems 传给每一个 TurnBlock，而 ChatWorkspace
// 每次 render 都重建这些数组（collectStreamed*）。默认浅比较 memo 永远命中不了。
// 按内容签名比较：非活跃 turn 与流式无关，直接按引用快速通道跳过；活跃 turn
// 只在流式文本/条目实质变化时重渲染。
function streamSignature(messages: StreamedAgentMessage[]) {
  if (messages.length === 0) return "0";
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.itemId}:${last.completed ? 1 : 0}:${last.text.length}:${last.text.slice(-64)}`;
}

function streamItemsSignature(items: StreamedTurnItem[] | undefined) {
  if (!items || items.length === 0) return "0";
  return `${items.length}:${items.map((entry) => entry.itemId).join(",")}`;
}

function turnBlockEqual(prev: TurnBlockProps, next: TurnBlockProps) {
  if (prev.turn !== next.turn) return false;
  if (prev.thread !== next.thread) {
    // thread 对象每轮都可能重建，只比较渲染实际使用的字段。
    const a = prev.thread;
    const b = next.thread;
    if (
      a.activeTurnId !== b.activeTurnId ||
      a.status !== b.status ||
      a.cwd !== b.cwd ||
      a.model !== b.model ||
      a.reasoningEffort !== b.reasoningEffort ||
      a.agentId !== b.agentId ||
      a.updatedAt !== b.updatedAt
    )
      return false;
  }
  if (
    prev.index !== next.index ||
    prev.highlighted !== next.highlighted ||
    prev.targetItemId !== next.targetItemId ||
    prev.targetRequest !== next.targetRequest ||
    prev.messageActionsDisabled !== next.messageActionsDisabled ||
    prev.pendingUsers !== next.pendingUsers ||
    prev.onCopy !== next.onCopy ||
    prev.onForkFrom !== next.onForkFrom ||
    prev.onEditUserMessage !== next.onEditUserMessage ||
    prev.onRetryUserMessage !== next.onRetryUserMessage
  )
    return false;
  return (
    streamSignature(prev.streamed) === streamSignature(next.streamed) &&
    streamItemsSignature(prev.streamedItems) ===
      streamItemsSignature(next.streamedItems)
  );
}

function TurnBlockInner({
  turn,
  index,
  thread,
  highlighted,
  targetItemId,
  targetRequest,
  streamed,
  streamedItems = [],
  pendingUsers = [],
  onCopy,
  onForkFrom,
  onEditUserMessage,
  onRetryUserMessage,
  messageActionsDisabled,
}: TurnBlockProps) {
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
  const newLiveIds = new Set(
    streamedItems.map((entry) => String(entry.itemId || "")).filter(Boolean),
  );
  const pendingBefore = new Map<number, PendingUserMessage[]>();
  const pendingAtEnd: PendingUserMessage[] = [];
  for (const message of pendingUsers) {
    const sentIds = new Set(message.liveItemIds || []);
    const index = renderEntries.findIndex((entry) => {
      const ids =
        entry.kind === "fileChangeGroup"
          ? entry.items.map((item) => String(item?.id || ""))
          : [String(entry.item?.id || "")];
      return ids.some((id) => newLiveIds.has(id) && !sentIds.has(id));
    });
    if (index < 0) pendingAtEnd.push(message);
    else
      pendingBefore.set(index, [...(pendingBefore.get(index) || []), message]);
  }
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
        const pendingMarkup = (pendingBefore.get(itemIndex) || []).map(
          (message) => (
            <OptimisticUserMessage key={message.id} message={message} />
          ),
        );
        if (entry.kind === "fileChangeGroup")
          return (
            <Fragment key={`file-group-${entry.items[0]?.id || itemIndex}`}>
              {pendingMarkup}
              <FileChangeGroup
                items={entry.items}
                changes={entry.changes as FileChange[]}
                cwd={thread.cwd}
              />
            </Fragment>
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
            thread={thread}
          />
        );
        return targeted ? (
          <div
            key={`${itemKey}:search:${targetRequest}`}
            className="search-item-target"
            data-item-id={item.id ? String(item.id) : undefined}
          >
            {pendingMarkup}
            {content}
          </div>
        ) : (
          <Fragment key={itemKey}>
            {pendingMarkup}
            {content}
          </Fragment>
        );
      })}
      {pendingAtEnd.map((message) => (
        <OptimisticUserMessage key={message.id} message={message} />
      ))}
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

export const TurnBlock = memo(TurnBlockInner, turnBlockEqual);
