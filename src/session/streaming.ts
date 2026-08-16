import { displayText } from "../format";

export interface StreamedAgentMessage {
  itemId: string;
  text: string;
  completed?: boolean;
}

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

export function appendCodexEvent(events: any[], event: any) {
  if (event?.method === "item/agentMessage/delta") {
    const existingIndex = events.findIndex((item) => sameStream(item, event));
    if (existingIndex >= 0) {
      const current = events[existingIndex];
      const merged = {
        ...current,
        params: {
          ...current.params,
          delta:
            displayText(current?.params?.delta) +
            displayText(event?.params?.delta),
        },
      };
      return [
        ...events.slice(0, existingIndex),
        ...events.slice(existingIndex + 1),
        merged,
      ];
    }
  }

  const updatedEvents =
    event?.method === "item/completed"
      ? events.map((item) =>
          completedStream(event, item)
            ? { ...item, streamCompleted: true }
            : item,
        )
      : events;

  const withoutPreviousTurn =
    event?.method === "turn/started" && event?.params?.threadId
      ? updatedEvents.filter(
          (item) =>
            item?.method !== "item/agentMessage/delta" ||
            (item?.agentId || "codex") !== (event?.agentId || "codex") ||
            item?.providerId !== event?.providerId ||
            item?.params?.threadId !== event?.params?.threadId,
        )
      : updatedEvents;
  const streams = withoutPreviousTurn.filter(
    (item) => item?.method === "item/agentMessage/delta",
  );
  const recentEvents = withoutPreviousTurn
    .filter((item) => item?.method !== "item/agentMessage/delta")
    .slice(-149);
  return [...recentEvents, ...streams, event];
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
  agentId: "codex" | "claude" = "codex",
): StreamedAgentMessage[] {
  const messages = new Map<string, StreamedAgentMessage>();

  for (const event of events) {
    if (event?.method !== "item/agentMessage/delta") continue;
    if ((event?.agentId || "codex") !== agentId) continue;
    if (event?.providerId && event.providerId !== providerId) continue;
    if (event?.params?.threadId !== threadId) continue;
    if (activeTurnId && event?.params?.turnId !== activeTurnId) continue;

    const itemId = displayText(event?.params?.itemId) || "agent-message";
    const delta = displayText(event?.params?.delta);
    if (!delta) continue;

    const current = messages.get(itemId);
    if (current) current.text += delta;
    else
      messages.set(itemId, {
        itemId,
        text: delta,
        ...(event?.streamCompleted ? { completed: true } : {}),
      });
  }

  return [...messages.values()];
}
