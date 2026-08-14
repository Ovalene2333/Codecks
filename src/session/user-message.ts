import { displayText } from "../format";
import type { ComposerDraft } from "./drafts";
import { MAX_COMPOSER_IMAGES, userImageParts } from "./images";

export function userMessageText(item: any) {
  if (Array.isArray(item?.content)) {
    const texts = item.content
      .filter(
        (part: any) =>
          !part?.type || part.type === "text" || part.type === "inputText",
      )
      .map((part: any) => displayText(part?.text ?? part))
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  return displayText(item?.text ?? item?.content);
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
