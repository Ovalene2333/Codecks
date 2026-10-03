import { userImageParts } from "./images";
import { userMessageText, visibleUserText } from "./user-message";

export interface LoadedUserMessage {
  turnId: string;
  itemId: string;
  text: string;
  imageCount: number;
  startedAt: number;
}

export function normalizedUserMessageText(text: string) {
  return visibleUserText(text).replace(/\r\n?/g, "\n");
}

export function loadedUserMessages(turns: any[]): LoadedUserMessage[] {
  return turns.flatMap((turn) =>
    (Array.isArray(turn?.items) ? turn.items : [])
      .filter((item: any) => item?.type === "userMessage")
      .map((item: any) => ({
        turnId: String(turn?.id || ""),
        itemId: String(item?.id || ""),
        text: normalizedUserMessageText(userMessageText(item)),
        imageCount: userImageParts(item).length,
        startedAt:
          typeof turn?.startedAt === "number"
            ? turn.startedAt
            : Date.parse(turn?.startedAt || ""),
      })),
  );
}

/** 按身份/内容扣除发送前已存在的消息，不使用全文中的数组位置。 */
function previousMessageIndexes(
  loaded: LoadedUserMessage[],
  before: LoadedUserMessage[],
) {
  const excluded = new Set<number>();
  for (const previous of before) {
    let index = loaded.findIndex(
      (actual, index) =>
        !excluded.has(index) &&
        previous.itemId &&
        actual.itemId === previous.itemId &&
        actual.turnId === previous.turnId,
    );
    if (index < 0)
      index = loaded.findIndex(
        (actual, index) =>
          !excluded.has(index) &&
          actual.text === previous.text &&
          actual.imageCount === previous.imageCount &&
          (actual.turnId === previous.turnId ||
            actual.turnId.startsWith("acp-replay-")),
      );
    if (index >= 0) excluded.add(index);
  }
  return excluded;
}

export function matchingUserMessageIndex(
  loaded: LoadedUserMessage[],
  message: {
    text: string;
    imageCount: number;
    turnId?: string;
    sentAt?: number;
  },
  matched: Set<number>,
  before: LoadedUserMessage[] = [],
  agentId = "codex",
) {
  const text = normalizedUserMessageText(message.text);
  const excluded = previousMessageIndexes(
    loaded,
    before.filter(
      (previous) =>
        previous.text === text ||
        (message.imageCount > 0 &&
          previous.text.replace(/(?:\s*\[image\])+\s*$/g, "").trim() === text),
    ),
  );
  const hasTarget = Boolean(
    message.turnId && loaded.some((actual) => actual.turnId === message.turnId),
  );
  return loaded.findIndex((actual, index) => {
    const sameTurn = Boolean(
      message.turnId && actual.turnId === message.turnId,
    );
    const replay = actual.turnId.startsWith("acp-replay-");
    const actualText =
      message.imageCount > 0 &&
      actual.imageCount === 0 &&
      (replay ||
        (sameTurn &&
          agentId !== "codex" &&
          agentId !== "claude" &&
          agentId !== "opencode"))
        ? actual.text.replace(/(?:\s*\[image\])+\s*$/g, "").trim()
        : actual.text;
    if (matched.has(index) || excluded.has(index) || actualText !== text)
      return false;
    // 首次历史尚未加载时发送：不能把刚到达的旧同文消息认作本次发送。
    // 获得回执 turnId 后可稳定关联；此前只信可核对的发送时间。
    if (
      !message.turnId &&
      message.sentAt !== undefined &&
      ((!Number.isFinite(actual.startedAt) && before.length === 0) ||
        (Number.isFinite(actual.startedAt) &&
          actual.startedAt < message.sentAt))
    )
      return false;
    if (message.turnId && !sameTurn) {
      if (hasTarget || agentId === "codex" || agentId === "claude")
        return false;
      // OpenCode 完成后采用原生消息 ID；ACP session/load 采用合成回放 ID。
      if (agentId !== "opencode" && !replay) return false;
      if (
        agentId === "opencode" &&
        Number.isFinite(actual.startedAt) &&
        message.sentAt !== undefined &&
        actual.startedAt < message.sentAt
      )
        return false;
    }
    return (
      actual.imageCount === message.imageCount ||
      // 老版 Claude/ACP 历史可能没有图片部分，但已有文本不能再在底部复制。
      (Boolean(text) &&
        actual.imageCount === 0 &&
        ((agentId === "claude" && actual.itemId === message.turnId) ||
          replay ||
          (sameTurn && agentId !== "codex" && agentId !== "opencode")))
    );
  });
}
