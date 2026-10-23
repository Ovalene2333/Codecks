import { useRef, useState } from "react";
import { RotateCcw, UserRound } from "lucide-react";
import type { MessageDelivery } from "../types";
import { Button } from "../kit";
import { DECK_PUSH_LABEL, deckPushKind } from "./user-message";

type Action = (id: string) => Promise<void>;

interface Actions {
  onCancel?: Action;
  onRetry?: Action;
  onEdit?: Action;
}

function DeliveryBubble({ item, onCancel, onRetry, onEdit }: Actions & {
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
  const canEdit = item.status === "queued" && onEdit;
  const canCancel = item.status !== "sending" && item.status !== "delivered" && onCancel;
  return (
    <div className={`message-block message-block--user user-message-wrap session-message-queue-item ${item.status}${push ? " is-deck-push" : ""}`} data-message-id={item.id}>
      <div className="rail-row message-block__head">
        <UserRound aria-hidden="true" />
        <span className="message-block__who">{push ? DECK_PUSH_LABEL[push] : "你"}</span>
        <span className="rail-row__head-right">
          <span className="rail-row__meta" role="status" aria-label={status} title={status}>{label}</span>
          <span className="session-message-queue-controls">
            {canEdit && <Button variant="ghost" size="sm" busy={acting}
              title="编辑：从队列取回，正文和图片放回输入框"
              onClick={() => void act(onEdit)}>编辑</Button>}
            {item.canRetry && onRetry && <Button variant="ghost" size="sm" busy={acting} title="重试"
              onClick={() => void act(onRetry)}><RotateCcw aria-hidden="true" />重试</Button>}
            {canCancel && <Button variant="ghost" size="sm" busy={acting}
              title={item.status === "failed" ? "移除这条失败记录" : "取消排队，不会放回输入框"}
              onClick={() => void act(onCancel)}>{item.status === "failed" ? "移除" : "取消"}</Button>}
          </span>
        </span>
      </div>
      <div className="message-block__body">
        <div className="message user">
          {item.text ?? item.preview}
          {Boolean(item.imageCount) && item.text !== undefined && <span className="session-message-queue-images">
            {item.imageCount} 张图片
          </span>}
          {item.error && <span className="session-message-queue-error" role="alert">{item.error}</span>}
        </div>
      </div>
    </div>
  );
}

export function MessageQueue({ items, ...actions }: Actions & { items: MessageDelivery[] }) {
  if (!items.length) return null;
  return (
    <div className="session-message-queue" aria-label="待发送消息">
      {items.filter((item) => !item.owner).map((item) => <DeliveryBubble key={item.id} item={item} {...actions} />)}
    </div>
  );
}
