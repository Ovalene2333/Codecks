import { useRef, useState } from "react";
import { RotateCcw, UserRound, X, Zap } from "lucide-react";
import type { MessageDelivery } from "../types";
import { Button } from "../kit";
import { DECK_PUSH_LABEL, deckPushKind } from "./user-message";

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
  const status = item.status === "delivered" ? "已受理，正在同步聊天记录"
    : item.status === "interrupting" ? "正在停止当前任务"
    : item.status === "sending" ? "正在发送"
    : item.status === "failed" ? "发送未完成"
    : item.mode === "queue" ? "已排队，等待当前任务结束" : "即时反馈，等待处理";
  const label = item.status === "delivered" ? "已发送"
    : item.status === "interrupting" ? "停止中"
    : item.status === "sending" ? "发送中"
    : item.status === "failed" ? "失败"
    : item.mode === "queue" ? "已排队" : "反馈";
  // 排队中的 Deck 注入消息（send / 唤醒）不是人手打的，说话人直接标推送类型。
  const push = deckPushKind(item.text ?? item.preview ?? "");
  return (
    <div className={`message-block message-block--user user-message-wrap session-message-queue-item ${item.status}${push ? " is-deck-push" : ""}`} data-message-id={item.id}>
      <div className="rail-row message-block__head">
        <UserRound aria-hidden="true" />
        <span className="message-block__who">{push ? DECK_PUSH_LABEL[push] : "你"}</span>
        <span className="rail-row__meta" role="status" aria-label={status} title={status}>{label}</span>
      </div>
      <div className="message-block__body">
        <div className="message user">
          {item.text ?? item.preview}
          {Boolean(item.imageCount) && item.text !== undefined && <span className="session-message-queue-images">
            {item.imageCount} 张图片
          </span>}
          {item.error && <span className="session-message-queue-error" role="alert">{item.error}</span>}
        </div>
        <span className="session-message-queue-controls">
          {canFeedback && <Button variant="ghost" iconOnly size="sm" busy={acting} aria-label="即时反馈"
            title={feedbackInterrupts ? "即时反馈：先停止当前任务，再发送这条消息" : "即时反馈：直接反馈给当前任务，无需停止"}
            onClick={() => void act(onFeedback)}><Zap aria-hidden="true" /></Button>}
          {item.canRetry && onRetry && <Button variant="ghost" iconOnly size="sm" busy={acting} aria-label="重试" title="重试"
            onClick={() => void act(onRetry)}><RotateCcw aria-hidden="true" /></Button>}
          {item.status !== "sending" && item.status !== "delivered" && onCancel && <Button variant="ghost" iconOnly size="sm" busy={acting}
            aria-label={item.status === "failed" ? "移除记录" : "取消"}
            title={item.status === "failed" ? "移除记录" : "取消排队"}
            onClick={() => void act(onCancel)}><X aria-hidden="true" /></Button>}
        </span>
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
