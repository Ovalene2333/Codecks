import type { MessageDelivery, ThreadSummary } from "../types";
import {
  mergeMessageDeliveries,
  visibleMessageDeliveries,
} from "./message-deliveries";
import {
  reconcilePendingUserMessages,
  type PendingUserMessage,
} from "./optimistic";
import { mergeTurnItems, type StreamedTurnItem } from "./streaming";
import {
  normalizedUserMessageText,
  type LoadedUserMessage,
} from "./user-message-reconcile";

export function renderedMessageTurns(
  thread: ThreadSummary,
  turns: any[],
  streamedItems: StreamedTurnItem[],
) {
  const active = turns.findIndex(
    (turn) =>
      turn?.id === thread.activeTurnId ||
      turn?.status === "inProgress" ||
      turn?.status === "running",
  );
  const rendered = turns.map((turn, index) =>
    index === active
      ? {
          ...turn,
          items: mergeTurnItems(
            Array.isArray(turn.items) ? turn.items : [],
            streamedItems,
          ),
        }
      : turn,
  );
  if (active < 0 && streamedItems.length)
    rendered.push({
      id: thread.activeTurnId,
      items: streamedItems.map((entry) => entry.item),
    });
  return rendered;
}

/** 用实际会渲染的历史 + live item 决定气泡归属，三种来源只显示一份。 */
export function reconcileTimelineMessages(
  thread: ThreadSummary,
  turns: any[],
  streamedItems: StreamedTurnItem[],
  pending: PendingUserMessage[],
  deliveries: MessageDelivery[],
  historyBefore?: ReadonlyMap<string, LoadedUserMessage[]>,
  pendingDeliveryIds?: ReadonlySet<string>,
) {
  const rendered = renderedMessageTurns(thread, turns, streamedItems);
  const receipts = mergeMessageDeliveries(deliveries, []);
  const visible = visibleMessageDeliveries(
    receipts,
    thread,
    rendered,
    historyBefore,
    pendingDeliveryIds,
  );
  const claimed = new Set<string>();
  const pendingUsers = reconcilePendingUserMessages(
    rendered,
    pending,
    thread.agentId || "codex",
  ).filter((message) => {
    // fullSnapshot 可能先于 HTTP 回执；此时持久队列气泡接管本地发送气泡。
    const receipt = receipts.find(
      (item) =>
        item.agentId === (thread.agentId || "codex") &&
        item.threadId === thread.id &&
        !claimed.has(item.id) &&
        !message.deliveryIdsBefore?.includes(item.id) &&
        (item.status !== "delivered" ||
          Boolean(message.deliveryIdsBefore) ||
          historyBefore?.has(item.id) ||
          pendingDeliveryIds?.has(item.id)) &&
        item.text !== undefined &&
        normalizedUserMessageText(item.text) ===
          normalizedUserMessageText(message.text) &&
        (item.imageCount ?? 0) === message.images.length,
    );
    if (!receipt) return true;
    claimed.add(receipt.id);
    return false;
  });
  return { pendingUsers, messageDeliveries: visible };
}
