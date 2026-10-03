import { displayText } from "../format";
import type { AgentId } from "../types";
import { openCodePartToItem } from "./adapters/native-parts";

export interface StreamedAgentMessage {
  itemId: string;
  text: string;
  completed?: boolean;
}

export interface StreamedTurnItem {
  itemId: string;
  item: any;
}

/**
 * 文本消息与事件类 item 在事件流里的统一先后序。渲染活跃 turn 的
 * live 尾巴时按此交错，而不是「先全部 item、再全部文本」分两段。
 */
export interface StreamedEntry {
  kind: "message" | "item";
  itemId: string;
}

const LIVE_ITEM_TYPES = new Set([
  "userMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "reasoning",
  "enteredReviewMode",
  "exitedReviewMode",
  "extension",
  "subAgentActivity",
  "collabAgentToolCall",
]);

function sameStream(left: any, right: any) {
  return (
    left?.method === "item/agentMessage/delta" &&
    right?.method === "item/agentMessage/delta" &&
    (left?.agentId || "codex") === (right?.agentId || "codex") &&
    left?.providerId === right?.providerId &&
    left?.params?.threadId === right?.params?.threadId &&
    left?.params?.turnId === right?.params?.turnId &&
    left?.params?.itemId === right?.params?.itemId
  );
}

function sameCommandOutput(left: any, right: any) {
  return (
    left?.method === "item/commandExecution/outputDelta" &&
    right?.method === "item/commandExecution/outputDelta" &&
    (left?.agentId || "codex") === (right?.agentId || "codex") &&
    left?.providerId === right?.providerId &&
    left?.params?.threadId === right?.params?.threadId &&
    left?.params?.turnId === right?.params?.turnId &&
    left?.params?.itemId === right?.params?.itemId
  );
}

function completedStream(event: any, stream: any) {
  const item = event?.params?.item;
  return (
    event?.method === "item/completed" &&
    item?.type === "agentMessage" &&
    (event?.agentId || "codex") === (stream?.agentId || "codex") &&
    event?.providerId === stream?.providerId &&
    event?.params?.threadId === stream?.params?.threadId &&
    event?.params?.turnId === stream?.params?.turnId &&
    item?.id === stream?.params?.itemId
  );
}

/**
 * OpenCode broadcasts full native part snapshots as `item/updated`; each
 * update replaces the previous snapshot for the same part, so coalesce them
 * in the bounded event buffer instead of evicting older live items.
 */
function sameNativeUpdate(left: any, right: any) {
  return (
    left?.method === "item/updated" &&
    right?.method === "item/updated" &&
    (left?.agentId || "codex") === (right?.agentId || "codex") &&
    left?.providerId === right?.providerId &&
    left?.params?.threadId === right?.params?.threadId &&
    left?.params?.turnId === right?.params?.turnId &&
    String(left?.params?.item?.id) === String(right?.params?.item?.id)
  );
}

const NON_DELTA_CAP = 149;

// 尾部追加 + 非 delta 上限 149。调用方维持一条不变量：delta 事件恒在数组尾部
// （合并时搬到末尾、新流追加到末尾），因此与旧实现“三次 filter + 两次 spread”
// 的结果顺序完全一致，只是少 3～4 倍临时数组。
function appendCapped(list: any[], event: any) {
  let nonDelta = event?.method === "item/agentMessage/delta" ? 0 : 1;
  let cut = -1;
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.method === "item/agentMessage/delta") continue;
    nonDelta++;
    if (nonDelta > NON_DELTA_CAP) {
      cut = index;
      break;
    }
  }
  if (cut < 0) return [...list, event];
  const next = list.slice();
  next.splice(cut, 1);
  next.push(event);
  return next;
}

export function appendCodexEvent(events: any[], event: any) {
  const method = event?.method;
  if (
    method === "item/agentMessage/delta" ||
    method === "item/commandExecution/outputDelta"
  ) {
    const same =
      method === "item/agentMessage/delta" ? sameStream : sameCommandOutput;
    // 合并后的 delta 恒在尾部，倒序扫命中即停；高频续写场景接近 O(1)。
    for (let index = events.length - 1; index >= 0; index--) {
      if (!same(events[index], event)) continue;
      const current = events[index];
      const merged = {
        ...current,
        params: {
          ...current.params,
          delta:
            displayText(current?.params?.delta) +
            displayText(event?.params?.delta),
        },
      };
      if (index === events.length - 1) {
        const next = events.slice();
        next[index] = merged;
        return next;
      }
      return [...events.slice(0, index), ...events.slice(index + 1), merged];
    }
  }

  if (method === "item/updated") {
    // OpenCode 原生 part 快照：同 part 旧快照摘除后走统一尾部追加。
    return appendCapped(
      events.filter((item) => !sameNativeUpdate(item, event)),
      event,
    );
  }

  const updatedEvents =
    method === "item/completed"
      ? events.map((item) =>
          completedStream(event, item)
            ? { ...item, streamCompleted: true }
            : item,
        )
      : events;

  const withoutPreviousTurn =
    method === "turn/started" && event?.params?.threadId
      ? updatedEvents.filter(
          (item) =>
            item?.method !== "item/agentMessage/delta" ||
            (item?.agentId || "codex") !== (event?.agentId || "codex") ||
            item?.providerId !== event?.providerId ||
            item?.params?.threadId !== event?.params?.threadId,
        )
      : updatedEvents;
  return appendCapped(withoutPreviousTurn, event);
}

export function activeStreamItemId(messages: StreamedAgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (!messages[index].completed) return messages[index].itemId;
  return undefined;
}

export function streamsCoveredByHistory(
  items: any[],
  messages: StreamedAgentMessage[],
) {
  const agentItems = items.filter((item) => item?.type === "agentMessage");
  const availableHistory = new Set(agentItems.map((_, index) => index));
  const covered = new Set<string>();

  for (const message of messages) {
    const index = agentItems.findIndex(
      (item, itemIndex) =>
        availableHistory.has(itemIndex) &&
        String(item?.id || "") === message.itemId,
    );
    if (index < 0) continue;
    availableHistory.delete(index);
    covered.add(message.itemId);
  }

  for (const message of messages) {
    if (!message.completed || covered.has(message.itemId)) continue;
    const index = agentItems.findIndex(
      (item, itemIndex) =>
        availableHistory.has(itemIndex) &&
        displayText(item?.text) === message.text,
    );
    if (index < 0) continue;
    availableHistory.delete(index);
    covered.add(message.itemId);
  }

  // Claude's live API message id and its persisted history uuid can differ.
  // Once history has a sufficiently specific prefix, keep the live item at
  // that historical position instead of appending it after later tool calls.
  for (const message of messages) {
    if (covered.has(message.itemId) || message.text.length < 24) continue;
    const index = agentItems.findIndex(
      (item, itemIndex) =>
        availableHistory.has(itemIndex) &&
        displayText(item?.text).startsWith(message.text),
    );
    if (index < 0) continue;
    availableHistory.delete(index);
    covered.add(message.itemId);
  }

  return covered;
}

export function collectStreamedAgentMessages(
  events: any[],
  providerId: string,
  threadId: string,
  activeTurnId?: string,
  agentId: AgentId = "codex",
): StreamedAgentMessage[] {
  return collectStreamed(events, providerId, threadId, activeTurnId, agentId)
    .messages;
}

export function collectStreamedTurnItems(
  events: any[],
  providerId: string,
  threadId: string,
  activeTurnId?: string,
  agentId: AgentId = "codex",
): StreamedTurnItem[] {
  return collectStreamed(events, providerId, threadId, activeTurnId, agentId)
    .items;
}

// ChatWorkspace  previously 在每次 render 里把 events 全扫两遍
// （messages 一遍 + items 一遍）。单遍联合收集，结果与两个旧函数逐项一致。
export function collectStreamed(
  events: any[],
  providerId: string,
  threadId: string,
  activeTurnId?: string,
  agentId: AgentId = "codex",
): {
  messages: StreamedAgentMessage[];
  items: StreamedTurnItem[];
  entries: StreamedEntry[];
} {
  const messages = new Map<string, StreamedAgentMessage>();
  const items = new Map<string, StreamedTurnItem>();
  const entries: StreamedEntry[] = [];
  const seen = new Set<string>();
  // delta 合并后位于缓冲区尾部 → 文本取「最后一次活动」的位置；
  // item 的首个事件（item/started）位置不变 → item 取「首次出现」的位置。
  // 这与持久化历史「按插入位置排列」的语义最接近。
  const place = (kind: StreamedEntry["kind"], itemId: string) => {
    const key = `${kind}:${itemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, itemId });
  };

  for (const event of events) {
    if ((event?.agentId || "codex") !== agentId) continue;
    if (event?.providerId && event.providerId !== providerId) continue;
    if (event?.params?.threadId !== threadId) continue;
    if (activeTurnId && event?.params?.turnId !== activeTurnId) continue;

    const method = String(event?.method || "");
    if (method === "item/agentMessage/delta") {
      const itemId = displayText(event?.params?.itemId) || "agent-message";
      const delta = displayText(event?.params?.delta);
      if (!delta) continue;
      place("message", itemId);
      const current = messages.get(itemId);
      if (current) current.text += delta;
      else
        messages.set(itemId, {
          itemId,
          text:
            (items.get(itemId)?.item?.type === "agentMessage"
              ? displayText(items.get(itemId)?.item?.text)
              : "") + delta,
          ...(event?.streamCompleted ? { completed: true } : {}),
        });
      continue;
    }
    const eventItem = event?.params?.item;
    if (method === "item/updated") {
      // Native part snapshot (OpenCode): convert to the shared item shape.
      const converted = openCodePartToItem(eventItem);
      const itemId = String(converted?.id || eventItem?.id || "");
      if (!itemId || !converted) continue;
      place("item", itemId);
      items.set(itemId, { itemId, item: converted });
      if (converted.type === "agentMessage") {
        const live = messages.get(itemId);
        const snapshot = displayText(converted.text);
        if (live && snapshot.length > live.text.length)
          live.text = snapshot;
      }
      continue;
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      eventItem?.id &&
      LIVE_ITEM_TYPES.has(eventItem.type)
    ) {
      const itemId = String(eventItem.id);
      place("item", itemId);
      const current = items.get(itemId)?.item;
      const status =
        method === "item/started"
          ? "inProgress"
          : eventItem.status || "completed";
      items.set(itemId, {
        itemId,
        item: { ...current, ...eventItem, status },
      });
      continue;
    }

    if (method === "item/commandExecution/outputDelta") {
      const itemId = displayText(event?.params?.itemId);
      const current = itemId ? items.get(itemId) : undefined;
      if (!current) continue;
      current.item = {
        ...current.item,
        aggregatedOutput:
          displayText(current.item?.aggregatedOutput) +
          displayText(event?.params?.delta),
      };
    }
  }

  return {
    messages: [...messages.values()],
    items: [...items.values()],
    entries,
  };
}

export function mergeTurnItems(
  historyItems: any[],
  streamedItems: StreamedTurnItem[],
) {
  if (streamedItems.length === 0) return historyItems;
  const liveById = new Map(streamedItems.map((entry) => [entry.itemId, entry]));
  const merged = historyItems.map((item) => {
    const itemId = item?.id ? String(item.id) : "";
    const live = itemId ? liveById.get(itemId) : undefined;
    if (!live) return item;
    liveById.delete(itemId);
    return { ...item, ...live.item };
  });
  return [...merged, ...Array.from(liveById.values(), (entry) => entry.item)];
}
