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
  Puzzle,
  RotateCcw,
  ScanSearch,
  Undo2,
  Wrench,
} from "lucide-react";
import { changeKindText, displayCommand, displayText, fmtTime } from "../format";
import { activityKey, useActivities, useNow } from "../monitor/activity-store";
import type { FileChange, ThreadSummary } from "../types";
import { FileDiff } from "./FileDiff";
import { AssistantMarkdown, DeferredImage } from "./markdown";
import {
  formatFoldedSize,
  formatToolDuration,
  formatTps,
  formatTurnDuration,
  progressTps,
  statsLine,
} from "./turn-stats";
import { assistantImageParts, userImageParts } from "./images";
import type {
  StreamedAgentMessage,
  StreamedEntry,
  StreamedTurnItem,
} from "./streaming";
import {
  activeStreamItemId,
  liveUserMessagesCoveredByHistory,
  mergeTurnItems,
  streamsCoveredByHistory,
} from "./streaming";
import { userMessageText } from "./user-message";
import type { PendingUserMessage } from "./optimistic";
import {
  collabAgentStateLabel,
  collabReceiverNames,
  collabToolLabel,
  commandPresentation,
  fileChangeGroupLabel,
  groupTurnItems,
  isTrivialToolOutput,
  openCodeFileTarget,
  reasoningText,
  subAgentActivityName,
  subAgentKindLabel,
  subAgentKindVerb,
  toolCallPresentation,
  turnReadTargets,
  type TurnRenderEntry,
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
  const type = displayText(item?.type) || "unknown";
  // 兜底行也走 tool-row 语言：类型名当动作，挑一个最像“对象”的字段当目标。
  const hint = displayText(
    item?.title || item?.command || item?.path || item?.tool || item?.name,
  );
  return (
    <details className="rail-row tool-row unknown-item">
      <summary>
        <Puzzle />
        <span className="tool-action">{type}</span>
        {hint ? (
          <code className="tool-command" title={hint}>
            {hint}
          </code>
        ) : null}
      </summary>
      <pre>{raw}</pre>
    </details>
  );
}

/**
 * 子代理卡片：OpenCode 的 task、Codex 的 collabAgentToolCall 与
 * subAgentActivity 共用同一副面孔——Bot 图标 + 状态色竖条 + 标题 +
 * 右侧标签 + 可展开输出。
 */
function SubAgentCard({
  state,
  action,
  title,
  tag,
  output,
  activity,
  time,
}: {
  state: "running" | "failed" | "interrupted" | "ok";
  action: string;
  title?: string;
  tag?: string;
  output?: string;
  activity?: string;
  time?: string;
}) {
  return (
    <div className={`rail-row tool-row subagent-row ${state}`}>
      <details>
        <summary>
          <Bot />
          <span className="tool-action">{action}</span>
          {title ? (
            <code className="tool-command" title={title}>
              {title}
            </code>
          ) : null}
          {tag ? (
            <span className="subagent-agent" title={tag}>
              {tag}
            </span>
          ) : null}
          {time ? <span className="tool-time">{time}</span> : null}
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

/** 工具行用时芯片：有起止计时才显示，只在展开态出现。 */
function ToolTime({ item }: { item: any }) {
  const text = formatToolDuration(item?.startedAt, item?.endedAt);
  return text ? <span className="tool-time">{text}</span> : null;
}

/**
 * 被折叠的工具输出加载入口：预览 + 体量 + 按回合粒度懒加载全文。
 * 回合级去重由 ChatWorkspace 的 expandTurn 保证，多点几次也只拉一次。
 */
function FoldedLoad({
  item,
  turnId,
  onExpandTurn,
}: {
  item: any;
  turnId?: string;
  onExpandTurn?: (turnId: string) => void;
}) {
  if (!item?.folded || !turnId || !onExpandTurn) return null;
  const size = formatFoldedSize(item.outputChars);
  return (
    <div className="folded-load">
      {item.outputPreview ? (
        <pre className="folded-preview">{`${item.outputPreview}…`}</pre>
      ) : null}
      <button
        type="button"
        className="folded-load-button"
        onClick={() => onExpandTurn(turnId)}
      >
        加载完整输出{size ? `（${size}）` : ""}
      </button>
    </div>
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
  onRevertUserMessage,
  messageActionsDisabled,
  thread,
  turnId,
  onExpandTurn,
}: {
  item: any;
  streamed?: string;
  streaming?: boolean;
  cwd?: string;
  onCopy?: () => void;
  onEditUserMessage?: (item: any) => void;
  onRetryUserMessage?: (item: any) => void;
  onRevertUserMessage?: (item: any) => void;
  messageActionsDisabled?: boolean;
  thread: ThreadSummary;
  turnId?: string;
  onExpandTurn?: (turnId: string) => void;
}) {
  // Per-agent adapters get first pick at items they understand (extension
  // payloads, agent-specific tool shapes); everything else falls through to
  // the shared Codex-shaped renderers below.
  const adapted = uiAdapterFor(thread.agentId)?.renderItem?.(item, { thread });
  if (adapted !== undefined) return adapted;
  if (item.type === "userMessage") {
    const images = userImageParts(item);
    const text = userText(item);
    // 整条都是注入上下文/控制回显的消息剥净后为空，不渲染空气泡。
    if (!text && !images.length) return null;
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
        {(onEditUserMessage || onRetryUserMessage || onRevertUserMessage) && (
          <div className="message-actions" aria-label="消息操作">
            {onEditUserMessage && (
              <button
                type="button"
                title={(thread.agentId || "codex") === "codex"
                  ? "回退此条及之后的对话，工作区文件不变"
                  : "撤回此条及之后，在当前会话编辑"}
                disabled={messageActionsDisabled}
                onClick={() => onEditUserMessage(item)}
              >
                <Pencil />
                编辑
              </button>
            )}
            {onRetryUserMessage && (
              <button
                type="button"
                title="从此处分支，可先在输入框编辑再发送；直接发送即用原文重试"
                disabled={messageActionsDisabled}
                onClick={() => onRetryUserMessage(item)}
              >
                <RotateCcw />
                从此重试
              </button>
            )}
            {onRevertUserMessage && (
              <button
                type="button"
                title="撤回该消息及之后全部（需确认）"
                disabled={messageActionsDisabled}
                onClick={() => onRevertUserMessage(item)}
              >
                <Undo2 />
                撤回
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  if (item.type === "enteredReviewMode")
    return (
      <div className="rail-row tool-row review-row">
        <ScanSearch />
        正在审查 {displayText(item.review) || "当前改动"}
      </div>
    );
  if (item.type === "exitedReviewMode")
    return (
      <div className="rail-row tool-row review-row done">
        <ScanSearch />
        审查完成
      </div>
    );
  if (item.type === "agentMessage") {
    const images = assistantImageParts(item);
    // 该条回复自己的生成统计（用时/TPS，服务端在 item 上盖章）。
    const itemStats = statsLine(item.stats);
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
        {itemStats ? <div className="message-stats">{itemStats}</div> : null}
        {streaming && <i />}
      </div>
    );
  }
  if (item.type === "reasoning")
    return (
      <details className="rail-row tool-row reasoning">
        <summary>
          <Activity />
          思考过程
        </summary>
        {item.stats ? (
          <div className="tool-time">{statsLine(item.stats)}</div>
        ) : null}
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
    return (
      <Fragment>
        <SubAgentCard
          state={state}
          action={
            state === "running"
              ? "子代理执行中"
              : state === "failed"
                ? "子代理失败"
                : "子代理"
          }
          title={displayText(item.title) || "子代理"}
          tag={displayText(item.agent)}
          output={displayText(item.aggregatedOutput)}
          activity={displayText(item.activity)}
          time={formatToolDuration(item.startedAt, item.endedAt)}
        />
        <FoldedLoad item={item} turnId={turnId} onExpandTurn={onExpandTurn} />
      </Fragment>
    );
  }
  // Codex 多代理：subAgentActivity 是子代理生命周期的 tick
  // （{kind, agentThreadId, agentPath}），展开给路径与线程 id 方便对照。
  if (item.type === "subAgentActivity") {
    const kind = String(item.kind || "");
    const name = subAgentActivityName(item);
    const path = displayText(item.agentPath ?? item.agent_path);
    const threadRef = displayText(item.agentThreadId ?? item.agent_thread_id);
    return (
      <SubAgentCard
        state={kind === "interrupted" ? "interrupted" : "ok"}
        action={subAgentKindLabel(kind)}
        title={name || threadRef}
        output={[path, threadRef].filter(Boolean).join("\n")}
      />
    );
  }
  // collabAgentToolCall 是父代理侧的协作工具调用（spawn/sendInput/
  // resume/wait/close），prompt 与 agentsStates 放进展开详情。
  if (item.type === "collabAgentToolCall") {
    const state =
      item.status === "inProgress"
        ? "running"
        : item.status === "failed"
          ? "failed"
          : "ok";
    const tool = String(item.tool || "");
    const prompt = displayText(item.prompt).trim();
    const receivers = (
      Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    )
      .map((id: any) => String(id || ""))
      .filter(Boolean);
    const receiverNames = collabReceiverNames(item);
    const states: Record<string, any> =
      item.agentsStates && typeof item.agentsStates === "object"
        ? item.agentsStates
        : {};
    const agentIds = [...new Set([...receivers, ...Object.keys(states)])];
    const agentName = (id: string) => receiverNames.get(id) || id.slice(0, 8);
    const agentLines = agentIds.map((id) =>
      [
        agentName(id),
        collabAgentStateLabel(states[id]?.status),
        displayText(states[id]?.message).trim(),
      ]
        .filter(Boolean)
        .join(" "),
    );
    const meta = [
      displayText(item.model),
      displayText(item.reasoningEffort),
    ]
      .filter(Boolean)
      .join(" · ");
    const title =
      prompt ||
      (agentIds.length === 1
        ? agentName(agentIds[0])
        : agentIds.length > 1
          ? `${agentIds.length} 个子代理`
          : "");
    return (
      <SubAgentCard
        state={state}
        action={collabToolLabel(tool, state === "running")}
        title={title}
        tag={displayText(item.model)}
        output={[meta, prompt, agentLines.join("\n")]
          .filter(Boolean)
          .join("\n\n")}
        activity={agentLines.join(" · ")}
      />
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
    const output = displayText(item.aggregatedOutput);
    const trivialOutput = isTrivialToolOutput(output);
    // shell 长命令运行时 output 为空：详情至少要展示完整命令，否则
    // <details> 点开展示空，看起来像“卡住且不能点开”。
    const fullCommand = displayCommand(
      displayText(presentation.target || command),
    );
    const description = displayText(
      item.description ?? item?.input?.description,
    ).trim();
    const detail =
      presentation.kind === "edit"
        ? trivialOutput
          ? ""
          : output
        : [
            // command 类 previously 只在 semantic 时展示 `$ 命令`，
            // bash 正好是非 semantic，直接导致详情为空。
            presentation.kind === "command" && fullCommand
              ? `$ ${fullCommand}`
              : semantic && command
                ? `$ ${command}`
                : "",
            description && description !== fullCommand ? description : "",
            output && !(trivialOutput && semantic) ? output : "",
            !output && item.status === "inProgress"
              ? "运行中，输出完成后显示…"
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");
    return (
      <details
        className={`rail-row tool-row command-row ${presentation.kind}-row ${state}`}
      >
        <summary>
          {presentation.kind === "read" ? (
            <BookOpenText />
          ) : presentation.kind === "explore" ? (
            <FolderSearch />
          ) : presentation.kind === "edit" ? (
            <Pencil />
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
        <ToolTime item={item} />
        {detail ? <pre>{detail}</pre> : null}
        <FoldedLoad item={item} turnId={turnId} onExpandTurn={onExpandTurn} />
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
      input ? `输入\n${input}` : "",
      output ? `输出\n${output}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <details className={`rail-row tool-row tool-call-row ${state}`}>
        <summary>
          <Wrench />
          <span className="tool-action">{tool}</span>
          {scope ? (
            <code className="tool-command" title={scope}>
              {scope}
            </code>
          ) : null}
        </summary>
        <ToolTime item={item} />
        {detail ? <pre>{detail}</pre> : null}
        <FoldedLoad item={item} turnId={turnId} onExpandTurn={onExpandTurn} />
      </details>
    );
  }
  // 裸图片项（imageView/imageGeneration 等没有专属渲染器的类型）兜底——
  // 必须排在已知类型之后，否则带 output/result/path 字段的工具项会被
  // 误识别成图片卡片。
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
  return <UnknownItem item={item} />;
}

// 历史 item 对象引用稳定时可跳过重渲染；streamed/streaming/cwd 变化仍正常更新。
// 回调多为父级内联箭头但语义稳定，默认浅比较已能过滤大部分无关重渲染。
const TurnItem = memo(TurnItemInner);

function FileChangeGroup({
  items,
  changes,
  cwd,
  turnId,
  onExpandTurn,
}: {
  items: any[];
  changes: FileChange[];
  cwd?: string;
  turnId?: string;
  onExpandTurn?: (turnId: string) => void;
}) {
  const label = fileChangeGroupLabel(changes);
  const state = items.some((item) => item?.status === "failed")
    ? "failed"
    : items.some((item) => item?.status === "inProgress")
      ? "running"
      : "ok";
  const foldedChars = items.reduce(
    (sum, item) => sum + (item?.folded ? Number(item.outputChars) || 0 : 0),
    0,
  );
  return (
    <details className={`rail-row tool-row file-change-group ${state}`}>
      <summary>
        <Files />
        <span className={`tool-action ${label}`}>{changeKindText(label)}</span>
        <span className="file-change-count">{changes.length} 个文件</span>
      </summary>
      <div className="file-change-group-content">
        <FileDiff changes={changes} cwd={cwd} />
        {foldedChars > 0 ? (
          <FoldedLoad
            item={{ folded: true, outputChars: foldedChars }}
            turnId={turnId}
            onExpandTurn={onExpandTurn}
          />
        ) : null}
      </div>
    </details>
  );
}

/**
 * OpenCode 连续编辑的收敛行：截图里 `已执行 docs/HANDOVER.md × 7`
 * 会收成一行 `编辑 docs/HANDOVER.md`，点开看每次的真实输出，
 * `Edit applied successfully.` 这类回执不再逐条占一行。
 */
function ToolGroup({
  items,
  label,
  files,
  cwd,
  turnId,
  onExpandTurn,
}: {
  items: any[];
  label: string;
  files: string[];
  cwd?: string;
  turnId?: string;
  onExpandTurn?: (turnId: string) => void;
}) {
  const state = items.some((item) => item?.status === "failed")
    ? "failed"
    : items.some((item) => item?.status === "inProgress")
      ? "running"
      : "ok";
  const distinct = files.filter(Boolean);
  const headline =
    distinct.length <= 1
      ? (distinct[0] || `${items.length} 次`)
      : `${distinct.length} 个文件`;
  const foldedChars = items.reduce(
    (sum, item) => sum + (item?.folded ? Number(item.outputChars) || 0 : 0),
    0,
  );
  return (
    <details
      className={`rail-row tool-row tool-group edit-group ${state}`}
      title={items.length > 1 ? `共 ${items.length} 次` : undefined}
    >
      <summary>
        <Pencil />
        <span className="tool-action edit">{label}</span>
        <span className="file-change-count">{headline}</span>
      </summary>
      <ul className="tool-group-list">
        {items.map((item, index) => {
          const file =
            openCodeFileTarget(item, cwd) ||
            displayCommand(displayText(item?.command)) ||
            `第 ${index + 1} 次`;
          const output = displayText(item?.aggregatedOutput);
          const showOutput =
            output && !isTrivialToolOutput(output) ? output : "";
          const status =
            item?.status === "failed"
              ? "失败"
              : item?.status === "inProgress"
                ? "进行中"
                : "";
          return (
            <li key={String(item?.id || `${file}-${index}`)}>
              <code title={file}>{file}</code>
              {status ? <span className="tool-status">{status}</span> : null}
              {showOutput ? <pre>{showOutput}</pre> : null}
            </li>
          );
        })}
      </ul>
      {foldedChars > 0 ? (
        <FoldedLoad
          item={{ folded: true, outputChars: foldedChars }}
          turnId={turnId}
          onExpandTurn={onExpandTurn}
        />
      ) : null}
    </details>
  );
}

/**
 * 同文件连续 edit/read 的收敛行：折叠时每类动作一行
 * （编辑 a.ts / 读取 a.ts），展开看各次回执；groupTurnItems 已把带
 * 真实输出或报错的条目排除在外，这里不会藏信息。
 */
function FileTouchGroup({
  file,
  actions,
  items,
  turnId,
  onExpandTurn,
}: {
  file: string;
  actions: { kind: "edit" | "read"; count: number }[];
  items: any[];
  turnId?: string;
  onExpandTurn?: (turnId: string) => void;
}) {
  const state = items.some((item) => item?.status === "failed")
    ? "failed"
    : items.some((item) => item?.status === "inProgress")
      ? "running"
      : "ok";
  // 动作词：两类都有收成「读写」，只有一类就是它自己；颜色跟着最重的动作。
  const bothKinds =
    actions.some((action) => action.kind === "edit") &&
    actions.some((action) => action.kind === "read");
  const actionLabel = bothKinds
    ? "读写"
    : actions[0]?.kind === "edit"
      ? "编辑"
      : "读取";
  return (
    <details className={`rail-row tool-row file-touch-group ${state}`}>
      <summary>
        {bothKinds || actions[0]?.kind === "edit" ? (
          <Pencil />
        ) : (
          <BookOpenText />
        )}
        <span className={`tool-action ${bothKinds ? "edit" : actions[0]?.kind}`}>
          {actionLabel}
        </span>
        <code className="tool-command" title={file}>
          {file}
        </code>
      </summary>
      <ul>
        {items.map((item, index) => (
          <li key={String(item?.id || index)}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
      <FoldedLoad item={items[0]} turnId={turnId} onExpandTurn={onExpandTurn} />
    </details>
  );
}

/** 连续的 subAgentActivity tick 收成一行；展开看每条的种类与目标代理。 */
function SubAgentTickGroup({ items }: { items: any[] }) {
  const kinds = [...new Set(items.map((item) => String(item?.kind || "")))];
  const label =
    kinds.length === 1 ? subAgentKindLabel(kinds[0]) : "子代理动态";
  const names = [
    ...new Set(items.map(subAgentActivityName).filter(Boolean)),
  ];
  return (
    <details
      className={`rail-row tool-row subagent-row subagent-ticks ${kinds.includes("interrupted") ? "interrupted" : "ok"}`}
    >
      <summary>
        <Bot />
        <span className="tool-action">{label}</span>
        <span className="file-change-count">{items.length} 条</span>
        {names.length ? (
          <code className="tool-command" title={names.join("、")}>
            {names.join("、")}
          </code>
        ) : null}
      </summary>
      <ul>
        {items.map((item, index) => {
          const name = subAgentActivityName(item);
          const path = displayText(item?.agentPath ?? item?.agent_path);
          return (
            <li key={String(item?.id || index)}>
              <span className="tool-status">
                {subAgentKindVerb(item?.kind) || "动态"}
              </span>
              <code title={path}>{name}</code>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function ReadSummary({ targets }: { targets: string[] }) {
  if (targets.length === 0) return null;
  return (
    <details className="rail-row tool-row read-summary">
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
  streamedEntries?: StreamedEntry[];
  pendingUsers?: PendingUserMessage[];
  /** 活跃回合的 turn/progress（状态行的实时 TPS 用；仅活跃回合块收到）。 */
  turnProgress?: {
    turnId?: string;
    outputTokens?: number;
    elapsedMs?: number;
  };
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
  onEditUserMessage?: (turnId: string, item: any) => void;
  onRetryUserMessage?: (turnId: string, item: any) => void;
  onRevertUserMessage?: (turnId: string, item: any) => void;
  /** 展开被折叠的回合工具输出（回合粒度懒加载，回调引用需保持稳定）。 */
  onExpandTurn?: (turnId: string) => void;
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

function streamEntriesSignature(entries: StreamedEntry[] | undefined) {
  if (!entries || entries.length === 0) return "0";
  return `${entries.length}:${entries
    .map((entry) => `${entry.kind === "item" ? "i" : "m"}${entry.itemId}`)
    .join(",")}`;
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
      a.resolvedModel !== b.resolvedModel ||
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
    prev.onRetryUserMessage !== next.onRetryUserMessage ||
    prev.onRevertUserMessage !== next.onRevertUserMessage ||
    prev.onExpandTurn !== next.onExpandTurn
  )
    return false;
  if (prev.turnProgress !== next.turnProgress) {
    const a = prev.turnProgress;
    const b = next.turnProgress;
    if (
      (a == null) !== (b == null) ||
      a?.turnId !== b?.turnId ||
      a?.outputTokens !== b?.outputTokens ||
      a?.elapsedMs !== b?.elapsedMs
    )
      return false;
  }
  return (
    streamSignature(prev.streamed) === streamSignature(next.streamed) &&
    streamItemsSignature(prev.streamedItems) ===
      streamItemsSignature(next.streamedItems) &&
    streamEntriesSignature(prev.streamedEntries) ===
      streamEntriesSignature(next.streamedEntries)
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
  streamedEntries,
  pendingUsers = [],
  turnProgress,
  onCopy,
  onForkFrom,
  onEditUserMessage,
  onRetryUserMessage,
  onRevertUserMessage,
  onExpandTurn,
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
  const readTargets = turnReadTargets(turnItems, thread.cwd);
  const streamedByItem = new Map(
    active ? streamed.map((message) => [message.itemId, message.text]) : [],
  );
  const streamingItemId = active ? activeStreamItemId(streamed) : undefined;
  const renderedStreamIds = active
    ? streamsCoveredByHistory(turnItems, streamed)
    : new Set<string>();
  // mergeTurnItems 把未进历史的 live item 追加在末尾；它们应与「同样未进
  // 历史」的 live 文本按 streamedEntries 的事件序交错渲染，否则运行中的
  // 时间线会变成「先全部事件、再全部文本」两段式错序。
  type LiveUnit =
    | TurnRenderEntry
    | { kind: "message"; message: StreamedAgentMessage };
  const liveUnits: LiveUnit[] = [];
  if (active) {
    // 老调用方（测试）不传 streamedEntries：退回「item 在前、文本在后」的旧序。
    const ordered: StreamedEntry[] = streamedEntries ?? [
      ...streamedItems.map(
        (entry): StreamedEntry => ({ kind: "item", itemId: entry.itemId }),
      ),
      ...streamed.map(
        (message): StreamedEntry => ({
          kind: "message",
          itemId: message.itemId,
        }),
      ),
    ];
    const historyIds = new Set(
      historyItems
        .map((item: any) => String(item?.id || ""))
        .filter(Boolean),
    );
    // userMessage 的 live id 与持久化 id 可能不一致（rollout 无稳定 id），
    // 已被历史按内容认领的 live 副本不能再渲染一遍。
    const coveredLiveIds = liveUserMessagesCoveredByHistory(
      historyItems,
      streamedItems,
    );
    const itemById = new Map(
      streamedItems.map((entry) => [entry.itemId, entry.item]),
    );
    const messageById = new Map(
      streamed.map((message) => [message.itemId, message]),
    );
    let run: any[] = [];
    const flushRun = () => {
      if (!run.length) return;
      liveUnits.push(...groupTurnItems(run, thread.cwd));
      run = [];
    };
    for (const entry of ordered) {
      if (entry.kind === "item") {
        if (historyIds.has(entry.itemId) || coveredLiveIds.has(entry.itemId))
          continue;
        const item = itemById.get(entry.itemId);
        if (item) run.push(item);
        continue;
      }
      if (renderedStreamIds.has(entry.itemId)) continue;
      const message = messageById.get(entry.itemId);
      if (!message) continue;
      flushRun();
      liveUnits.push({ kind: "message", message });
    }
    flushRun();
  }
  const renderEntries: LiveUnit[] = [
    ...groupTurnItems(turnItems.slice(0, historyItems.length), thread.cwd),
    ...liveUnits,
  ];
  const newLiveIds = new Set(
    streamedItems.map((entry) => String(entry.itemId || "")).filter(Boolean),
  );
  const pendingBefore = new Map<number, PendingUserMessage[]>();
  const pendingAtEnd: PendingUserMessage[] = [];
  for (const message of pendingUsers) {
    const sentIds = new Set(message.liveItemIds || []);
    const index = renderEntries.findIndex((entry) => {
      const ids: string[] =
        entry.kind === "item"
          ? [String(entry.item?.id || "")]
          : entry.kind === "message"
            ? []
            : entry.items.map((item: any) => String(item?.id || ""));
      return ids.some((id: string) => newLiveIds.has(id) && !sentIds.has(id));
    });
    if (index < 0) pendingAtEnd.push(message);
    else
      pendingBefore.set(index, [...(pendingBefore.get(index) || []), message]);
  }
  const started =
    Date.parse(turn.startedAt || turn.createdAt || turn.updatedAt || "") ||
    thread.updatedAt;
  // 服务端按回合打标（历史或发送时快照）；没有打标的旧数据才回落到
  // 会话当前设置。打标过的回合不回落 effort，「当时没设」就是没设。
  const model = turn.model || thread.resolvedModel || thread.model;
  const effort = turn.model ? turn.reasoningEffort : thread.reasoningEffort;
  const stats = statsLine(turn.stats);
  return (
    <section
      className={`turn-block ${active ? "active" : ""} ${highlighted ? "search-target" : ""}`}
      data-turn-id={turn?.id ? String(turn.id) : undefined}
    >
      <ReadSummary targets={readTargets} />
      {renderEntries.map((entry, itemIndex) => {
        const pendingMarkup = (pendingBefore.get(itemIndex) || []).map(
          (message) => (
            <OptimisticUserMessage key={message.id} message={message} />
          ),
        );
        if (entry.kind === "message") {
          const message = entry.message;
          return (
            <Fragment key={`live-msg-${message.itemId}`}>
              {pendingMarkup}
              <div
                className={`message agent ${message.itemId === streamingItemId ? "streaming" : ""}`}
              >
                <AssistantMarkdown text={message.text} onCopy={onCopy} />
                {message.itemId === streamingItemId && <i />}
              </div>
            </Fragment>
          );
        }
        if (entry.kind === "fileChangeGroup")
          return (
            <Fragment key={`file-group-${entry.items[0]?.id || itemIndex}`}>
              {pendingMarkup}
              <FileChangeGroup
                items={entry.items}
                changes={entry.changes as FileChange[]}
                cwd={thread.cwd}
                turnId={turn?.id ? String(turn.id) : undefined}
                onExpandTurn={onExpandTurn}
              />
            </Fragment>
          );
        if (entry.kind === "toolGroup")
          return (
            <Fragment key={`tool-group-${entry.items[0]?.id || itemIndex}`}>
              {pendingMarkup}
              <ToolGroup
                items={entry.items}
                label={entry.label}
                files={entry.files}
                cwd={thread.cwd}
                turnId={turn?.id ? String(turn.id) : undefined}
                onExpandTurn={onExpandTurn}
              />
            </Fragment>
          );
        if (entry.kind === "fileTouchGroup")
          return (
            <Fragment key={`file-touch-${entry.items[0]?.id || itemIndex}`}>
              {pendingMarkup}
              <FileTouchGroup
                file={entry.file}
                actions={entry.actions}
                items={entry.items}
                turnId={turn?.id ? String(turn.id) : undefined}
                onExpandTurn={onExpandTurn}
              />
            </Fragment>
          );
        if (entry.kind === "subAgentGroup")
          return (
            <Fragment key={`subagent-group-${entry.items[0]?.id || itemIndex}`}>
              {pendingMarkup}
              <SubAgentTickGroup items={entry.items} />
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
            onEditUserMessage={
              onEditUserMessage
                ? (item) => onEditUserMessage(String(turn.id), item)
                : undefined
            }
            onRetryUserMessage={
              onRetryUserMessage
                ? (item) => onRetryUserMessage(String(turn.id), item)
                : undefined
            }
            onRevertUserMessage={
              onRevertUserMessage
                ? (item) => onRevertUserMessage(String(turn.id), item)
                : undefined
            }
            messageActionsDisabled={messageActionsDisabled}
            thread={thread}
            turnId={turn?.id ? String(turn.id) : undefined}
            onExpandTurn={onExpandTurn}
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
      <TurnMetaLine
        thread={thread}
        turn={turn}
        index={index}
        turnProgress={turnProgress}
        onForkFrom={onForkFrom}
        active={active}
        completed={completed}
        started={started}
        model={model}
        effort={effort}
      />
    </section>
  );
}

export const TurnBlock = memo(TurnBlockInner, turnBlockEqual);

/**
 * 回合收针行（Turn meta）：每回合末尾一行，像 git graph 上的一个 commit node。
 * 进行中：扳手图标 + 阶段词 + 实时秒表 + 实时 TPS，全靠左一行干净。
 * 结束后沉淀为静态元信息：常驻分支按钮靠左，右端是第 n 轮、结束时间、
 * 模型 + effort（用时/TPS 不上尾行，在各段与工具详情里看）；
 * 中缝留白撑开。
 */
function TurnMetaLine({
  thread,
  turn,
  index,
  turnProgress,
  onForkFrom,
  active,
  completed,
  started,
  model,
  effort,
}: {
  thread: ThreadSummary;
  turn: any;
  index: number;
  turnProgress?: {
    turnId?: string;
    outputTokens?: number;
    elapsedMs?: number;
  };
  onForkFrom?: (turnId: string) => void;
  active: boolean;
  completed: boolean;
  started: number;
  model?: string;
  effort?: string;
}) {
  const activities = useActivities();
  const now = useNow(1_000);
  const activity = activities.get(activityKey(thread.agentId, thread.id));
  const waiting = active && thread.status === "waiting";
  const stepType = activity?.step?.item?.type;
  const freshProgress =
    turnProgress &&
    (!turn.id ||
      !turnProgress.turnId ||
      turnProgress.turnId === String(turn.id))
      ? turnProgress
      : undefined;
  const phaseLabel = waiting
    ? "等待确认"
    : stepType === "reasoning"
      ? "正在思考"
      : stepType === "agentMessage"
        ? "输出回复"
        : "正在运行";
  const startedAt = activity?.turnStartedAt ?? started ?? now;
  // 运行秒表沿用「用时 x.x s」口径，与思考/回复段的统计同一套样式；
  // 结束回合用 turn.stats 的终值，共用同一列宽与运行态跨行对齐。
  const usageText = active
    ? `用时 ${formatTurnDuration(Math.max(0, now - startedAt))}`
    : usageOf(turn);
  const tpsText = active
    ? waiting
      ? ""
      : progressTps(freshProgress)
    : formatTps(turn?.stats?.tps);
  const forkable = completed && turn.id && onForkFrom ? onForkFrom : undefined;
  if (active) {
    return (
      <div
        className={`rail-row rail-row--meta rail-row--running${waiting ? " rail-row--waiting" : ""}`}
        aria-label={`第 ${index} 轮，${phaseLabel}`}
      >
        <Wrench />
        <span className="rail-row__phase">{phaseLabel}</span>
        <span className="rail-row__usage">{usageText}</span>
        <span className="rail-row__tps">{tpsText}</span>
      </div>
    );
  }
  // 结束时间：回合更新时间就是收针时刻，老数据回落到推算的开始时间。
  const endedAt = Date.parse(turn?.updatedAt || "") || started;
  return (
    <div className="rail-row rail-row--meta" aria-label={`第 ${index} 轮`}>
      {forkable ? (
        <button
          type="button"
          className="rail-row__fork"
          onClick={() => forkable(turn.id)}
          title="从此处分支，可先在输入框编辑再发送；直接发送即用原文重试"
          aria-label="从此处分支"
        >
          <GitFork />
          创建分支
        </button>
      ) : null}
      <span className="rail-row__usage">{usageText}</span>
      <span className="rail-row__tps">{tpsText}</span>
      <span className="rail-row__spacer" aria-hidden="true" />
      <span className="rail-row__round">第 {index} 轮</span>
      <span className="rail-row__end">{fmtTime(endedAt)}</span>
      {/* 窄屏把 用时/TPS/模型 换到第二行的断行点；桌面隐藏。 */}
      <i className="rail-row__break" aria-hidden="true" />
      {model ? (
        <span
          className="rail-row__model"
          title={model !== shortModel(model) ? model : undefined}
        >
          {effort ? `${shortModel(model)}-${effort}` : shortModel(model)}
        </span>
      ) : effort ? (
        <span className="rail-row__effort">{effort}</span>
      ) : null}
    </div>
  );
}

/** 表头模型缩写：裁掉供应商前缀（opencode-go/glm-5.3 → glm-5.3），全称悬停可见。 */
function shortModel(model?: string) {
  return String(model || "").split("/").pop() || "";
}

/** 已结束回合的总用时（收针行的「用时」列）：优先 stats，老数据回推。 */
function usageOf(turn: any) {
  const stats = turn?.stats;
  if (stats && Number(stats.durationMs) > 0)
    return `用时 ${formatTurnDuration(stats.durationMs)}`;
  const startAt = Date.parse(turn?.startedAt || turn?.createdAt || "") || 0;
  const endAt = Date.parse(turn?.updatedAt || "") || 0;
  if (startAt > 0 && endAt > startAt)
    return `用时 ${formatTurnDuration(endAt - startAt)}`;
  return "";
}
