import { displayText } from "../format";
import type { ComposerDraft } from "./drafts";
import { MAX_COMPOSER_IMAGES, userImageParts } from "./images";

/**
 * 各家 agent 注入在 user 消息里的内部上下文块：Claude 的
 * <system-reminder>/IDE 上下文/hook 回执/任务通知/本地命令标签，
 * Codex 的 <environment_context>/<user_instructions>/AGENTS.md 注入，
 * 以及 "[Request interrupted by user…]" 中断回显。渲染成用户气泡前
 * 剥掉；整条全是注入内容时返回空串，气泡随之隐藏。与服务端
 * server/agents/injected-context.ts 同步维护。
 */
const INJECTED_BLOCK_PATTERN =
  /<(system-reminder|task-notification|ide_[a-z_]+|[a-z]+(?:-[a-z]+)*-hook|command-name|command-message|command-args|local-command-[a-z]+|bash-(?:input|stdout|stderr)|environment_context|user_instructions|recommended_plugins)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi;

const AGENTS_INSTRUCTIONS_PATTERN =
  /#\s*AGENTS\.md instructions for [^\n]*\s*<INSTRUCTIONS>[\s\S]*?<\/\s*INSTRUCTIONS\s*>/gi;

const INTERRUPT_ECHO_PATTERN = /^\[request interrupted by user[^\]]*\]$/i;

export function visibleUserText(text: string) {
  const stripped = text
    .replace(AGENTS_INSTRUCTIONS_PATTERN, "")
    .replace(INJECTED_BLOCK_PATTERN, "")
    .trim();
  return INTERRUPT_ECHO_PATTERN.test(stripped) ? "" : stripped;
}

export function userMessageText(item: any) {
  if (Array.isArray(item?.content)) {
    const texts = item.content
      .filter(
        (part: any) =>
          !part?.type || part.type === "text" || part.type === "inputText",
      )
      .map((part: any) => displayText(part?.text ?? part))
      .filter(Boolean);
    if (texts.length) return visibleUserText(texts.join("\n"));
  }
  return visibleUserText(displayText(item?.text ?? item?.content));
}

export function draftFromUserMessage(item: any): {
  draft: ComposerDraft;
  skippedImages: number;
} {
  const parts = userImageParts(item);
  const reusable = parts
    .filter((image) => image.url.startsWith("data:image/"))
    .slice(0, MAX_COMPOSER_IMAGES)
    .map((image, index) => ({
      id: `history-${String(item?.id || "message")}-${index}`,
      name: image.alt || `image-${index + 1}`,
      url: image.url,
    }));
  return {
    draft: { text: userMessageText(item), images: reusable },
    skippedImages: parts.length - reusable.length,
  };
}
