import type { MessageDelivery, ThreadSummary } from "../types";
import {
  loadedUserMessages,
  matchingUserMessageIndex,
  type LoadedUserMessage,
} from "./user-message-reconcile";

/** 快照优先于本地 HTTP 回执；回执填补首次快照到达前的空窗。 */
export function mergeMessageDeliveries(
  snapshot: MessageDelivery[],
  receipts: MessageDelivery[],
) {
  const merged = new Map(receipts.map((item) => [item.id, item]));
  for (const item of snapshot) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** delivered 只确认受理，不能在对应聊天正文加载前移除气泡。 */
export function visibleMessageDeliveries(
  deliveries: MessageDelivery[],
  thread: Pick<ThreadSummary, "id" | "agentId" | "activeTurnId">,
  turns: any[],
  historyBefore: ReadonlyMap<string, LoadedUserMessage[]> = new Map(),
  pendingDeliveryIds: ReadonlySet<string> = new Set(),
) {
  const loaded = loadedUserMessages(turns);
  const matched = new Set<number>();
  return deliveries.filter((item) => {
    if (
      item.agentId !== (thread.agentId || "codex") ||
      item.threadId !== thread.id
    )
      return false;
    if (!["sending", "delivered"].includes(item.status)) return true;
    // 旧服务端完成记录只有预览，不把截断的正文当成新消息展示。
    if (item.text === undefined) return item.status !== "delivered";
    const index = matchingUserMessageIndex(
      loaded,
      { ...item, text: item.text, imageCount: item.imageCount ?? 0 },
      matched,
      historyBefore.get(item.id),
      item.agentId,
    );
    // 完成回执不是聊天记录。打开会话/读尾部缓存时，不能把服务端保存的
    // 旧回执当成新消息追加到底部；只为正在交接的投递提供临时补位。
    if (index < 0)
      return (
        item.status !== "delivered" ||
        pendingDeliveryIds.has(item.id) ||
        historyBefore.has(item.id) ||
        (Boolean(item.turnId) && item.turnId === thread.activeTurnId)
      );
    matched.add(index);
    return false;
  });
}
