import { displayText } from "../format";

export interface StreamedAgentMessage {
  itemId: string;
  text: string;
}

function sameStream(left: any, right: any) {
  return (
    left?.method === "item/agentMessage/delta" &&
    right?.method === "item/agentMessage/delta" &&
    left?.providerId === right?.providerId &&
    left?.params?.threadId === right?.params?.threadId &&
    left?.params?.turnId === right?.params?.turnId &&
    left?.params?.itemId === right?.params?.itemId
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

  const withoutPreviousTurn =
    event?.method === "turn/started" && event?.params?.threadId
      ? events.filter(
          (item) =>
            item?.method !== "item/agentMessage/delta" ||
            item?.providerId !== event?.providerId ||
            item?.params?.threadId !== event?.params?.threadId,
        )
      : events;
  const streams = withoutPreviousTurn.filter(
    (item) => item?.method === "item/agentMessage/delta",
  );
  const recentEvents = withoutPreviousTurn
    .filter((item) => item?.method !== "item/agentMessage/delta")
    .slice(-149);
  return [...recentEvents, ...streams, event];
}

export function activeStreamItemId(messages: StreamedAgentMessage[]) {
  return messages.at(-1)?.itemId;
}

export function collectStreamedAgentMessages(
  events: any[],
  providerId: string,
  threadId: string,
  activeTurnId?: string,
): StreamedAgentMessage[] {
  const messages = new Map<string, StreamedAgentMessage>();

  for (const event of events) {
    if (event?.method !== "item/agentMessage/delta") continue;
    if (event?.providerId && event.providerId !== providerId) continue;
    if (event?.params?.threadId !== threadId) continue;
    if (activeTurnId && event?.params?.turnId !== activeTurnId) continue;

    const itemId = displayText(event?.params?.itemId) || "agent-message";
    const delta = displayText(event?.params?.delta);
    if (!delta) continue;

    const current = messages.get(itemId);
    if (current) current.text += delta;
    else messages.set(itemId, { itemId, text: delta });
  }

  return [...messages.values()];
}
