import { useRef, useState } from "react";
import { RotateCcw, X, Zap } from "lucide-react";
import type { MessageDelivery } from "../types";

type Action = (id: string) => Promise<void>;

interface Actions {
  onCancel?: Action;
  onRetry?: Action;
  onFeedback?: Action;
  feedbackInterrupts?: boolean;
}

function DeliveryBubble({ item, onCancel, onRetry, onFeedback, feedbackInterrupts }: Actions & {
  item: MessageDelivery;
}) {
  const actionPending = useRef(false);
  const [acting, setActing] = useState(false);
  const act = async (action: Action) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setActing(true);
    try { await action(item.id); }
    finally { actionPending.current = false; setActing(false); }
  };
  const canFeedback = item.status === "queued" && item.mode === "queue" && onFeedback;
  const status = item.status === "delivered" ? "后端已受理，正在同步聊天记录"
    : item.status === "interrupting" ? "正在停止当前任务"
    : item.status === "sending" ? "正在发送"
    : item.status === "failed" ? "发送未完成"
    : item.mode === "queue" ? "已追加 · 等待当前任务结束" : "即时反馈 · 等待处理";
  const label = item.status === "delivered" ? "已发送"
    : item.status === "interrupting" ? "停止中"
    : item.status === "sending" ? "发送中"
    : item.status === "failed" ? "失败"
    : item.mode === "queue" ? "已追加" : "反馈";
  return (
    <div className={`user-message-wrap session-message-queue-item ${item.status}`} data-message-id={item.id}>
      <div className="message user">
        {item.text ?? item.preview}
        {Boolean(item.imageCount) && item.text !== undefined && <span className="session-message-queue-images">
          {item.imageCount} 张图片
        </span>}
        <span className="session-message-queue-controls">
          <span role="status" aria-label={status} title={status}>{label}</span>
          {canFeedback && <button type="button" disabled={acting} aria-label="即时反馈"
            title={feedbackInterrupts ? "即时反馈：先停止当前任务，再发送这条消息" : "即时反馈：直接反馈给当前任务，无需停止"}
            onClick={() => void act(onFeedback)}><Zap aria-hidden="true" /></button>}
          {item.canRetry && onRetry && <button type="button" disabled={acting} aria-label="重试" title="重试"
            onClick={() => void act(onRetry)}><RotateCcw aria-hidden="true" /></button>}
          {item.status !== "sending" && item.status !== "delivered" && onCancel && <button type="button" disabled={acting}
            aria-label={item.status === "failed" ? "移除记录" : "取消"}
            title={item.status === "failed" ? "移除记录" : "取消追加"}
            onClick={() => void act(onCancel)}><X aria-hidden="true" /></button>}
        </span>
        {item.error && <span className="session-message-queue-error" role="alert">{item.error}</span>}
      </div>
    </div>
  );
}

export function MessageQueue({ items, ...actions }: Actions & { items: MessageDelivery[] }) {
  if (!items.length) return null;
  return (
    <div className="session-message-queue" aria-label="待发送消息">
      {items.map((item) => <DeliveryBubble key={item.id} item={item} {...actions} />)}
    </div>
  );
}
