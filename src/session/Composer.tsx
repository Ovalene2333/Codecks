import { useEffect, useRef } from "react";
import { CircleStop, Send } from "lucide-react";
import type { ThreadSummary } from "../types";

export function Composer({
  thread,
  text,
  sending,
  onChange,
  onSend,
  onStop,
}: {
  thread: ThreadSummary;
  text: string;
  sending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const compacting = Boolean(thread.compacting);
  const running = thread.status === "running";
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [text]);
  return (
    <footer
      className={`composer ${running ? "running" : ""} ${compacting ? "compacting" : ""}`}
    >
      <div className="composer-box">
        {running && thread.activeTurnId ? (
          <button
            type="button"
            className="send stop"
            title="停止"
            onClick={onStop}
          >
            <CircleStop />
          </button>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={compacting}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={
            compacting
              ? "正在压缩上下文"
              : running
                ? "追加到当前任务…"
                : "发送新指令…"
          }
        />
        <button
          type="button"
          className="send"
          title={running ? "追加到当前任务" : "发送新指令"}
          onClick={onSend}
          disabled={compacting || !text.trim() || sending}
        >
          <Send />
        </button>
      </div>
    </footer>
  );
}
