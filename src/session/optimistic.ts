import type { ComposerImage } from "./images";
import {
  loadedUserMessages,
  matchingUserMessageIndex,
  type LoadedUserMessage,
} from "./user-message-reconcile";

export { loadedUserMessages } from "./user-message-reconcile";

export interface PendingUserMessage {
  id: string;
  text: string;
  images: ComposerImage[];
  historyBefore: LoadedUserMessage[];
  deliveryIdsBefore?: string[];
  turnId?: string;
  sentAt?: number;
  liveItemIds?: string[];
}

export function reconcilePendingUserMessages(
  turns: any[],
  pending: PendingUserMessage[],
  agentId = "codex",
) {
  if (!pending.length) return pending;
  const loaded = loadedUserMessages(turns);
  if (!loaded.length) return pending;

  const matchedIndexes = new Set<number>();
  const unmatched: PendingUserMessage[] = [];
  for (const message of pending) {
    const match = matchingUserMessageIndex(
      loaded,
      { ...message, imageCount: message.images.length },
      matchedIndexes,
      message.historyBefore,
      agentId,
    );
    if (match >= 0) matchedIndexes.add(match);
    else unmatched.push(message);
  }
  return unmatched;
}
