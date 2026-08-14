import { displayText } from "../format";
import type { ComposerImage } from "./images";
import { userImageParts } from "./images";

export interface PendingUserMessage {
  id: string;
  text: string;
  images: ComposerImage[];
  loadedUserMessageCount: number;
}

export function loadedUserMessages(turns: any[]) {
  return turns.flatMap((turn) =>
    (Array.isArray(turn?.items) ? turn.items : [])
      .filter((item: any) => item?.type === "userMessage")
      .map((item: any) => ({
        text: displayText(item?.text ?? item?.content).trim(),
        imageCount: userImageParts(item).length,
      })),
  );
}

export function reconcilePendingUserMessages(
  turns: any[],
  pending: PendingUserMessage[],
) {
  if (!pending.length) return pending;
  const loaded = loadedUserMessages(turns);
  if (!loaded.length) return pending;

  const matchedIndexes = new Set<number>();
  const unmatched: PendingUserMessage[] = [];
  for (const message of pending) {
    const match = loaded.findIndex(
      (actual, index) =>
        index >= message.loadedUserMessageCount &&
        !matchedIndexes.has(index) &&
        actual.text === message.text.trim() &&
        (message.images.length === 0 ||
          actual.imageCount === message.images.length),
    );
    if (match >= 0) matchedIndexes.add(match);
    else
      unmatched.push({
        ...message,
        loadedUserMessageCount: Math.max(
          message.loadedUserMessageCount,
          loaded.length,
        ),
      });
  }
  return unmatched;
}
