import { Activity, Command, GitFork } from "lucide-react";
import { displayCommand, displayText, fmtTime } from "../format";
import type { FileChange, ThreadSummary } from "../types";
import { FileDiff } from "./FileDiff";
import { AssistantMarkdown } from "./markdown";

export function userText(item: any) {
  if (Array.isArray(item?.content)) {
    const texts = item.content
      .filter(
        (part: any) =>
          !part?.type || part.type === "text" || part.type === "inputText",
      )
      .map((part: any) => displayText(part?.text ?? part))
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  return displayText(item?.text ?? item?.content);
}

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
  hideAgent,
  cwd,
  onCopy,
}: {
  item: any;
  streamed?: string;
  hideAgent?: boolean;
  cwd?: string;
  onCopy?: () => void;
}) {
  if (item.type === "userMessage")
    return <div className="message user">{userText(item)}</div>;
  if (item.type === "agentMessage") {
    if (hideAgent) return <></>;
    return (
      <div className="message agent">
        <AssistantMarkdown text={displayText(item.text)} onCopy={onCopy} />
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
      <FileDiff
        changes={item.changes as FileChange[] | undefined}
        cwd={cwd}
      />
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
}: {
  turn: any;
  index: number;
  thread: ThreadSummary;
  streamed?: string;
  onCopy?: () => void;
  onForkFrom?: (turnId: string) => void;
}) {
  const active =
    turn.id === thread.activeTurnId || turn.status === "inProgress";
  const completed = !active && turn.status !== "running";
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
      {(Array.isArray(turn.items) ? turn.items : []).map((item: any) => (
        <TurnItem
          key={item.id || `${item.type}-${item.command || ""}`}
          item={item}
          streamed={streamed}
          hideAgent={Boolean(streamed && active && item.type === "agentMessage")}
          cwd={thread.cwd}
          onCopy={onCopy}
        />
      ))}
      {streamed && active && (
        <div className="message agent streaming">
          <AssistantMarkdown text={streamed} onCopy={onCopy} />
          <i />
        </div>
      )}
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
