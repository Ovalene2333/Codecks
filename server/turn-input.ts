import type { ReviewTarget, TurnImage } from "./types.js";

const IMAGE_DATA_URL =
  /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

export const INIT_PROMPT =
  "Create or update AGENTS.md in this repository with concise, repo-specific instructions for Codex. Inspect the project layout, build/test commands, conventions, and important constraints. Keep useful existing content.";

export const PLAN_PROMPT =
  "Enter plan mode. Do not edit files or run mutating commands. Inspect the current workspace and produce a concrete implementation plan.";

export const DIFF_SHELL_COMMAND =
  "git status --short && git diff && git diff --cached";

export function isAllowedImageUrl(url: string) {
  return IMAGE_DATA_URL.test(url.trim());
}

export function buildTurnInput(text: string, images?: TurnImage[]) {
  const input: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  if (trimmed) input.push({ type: "text", text: trimmed, text_elements: [] });
  for (const image of images || []) {
    const url = String(image?.url || "").trim();
    if (!url) continue;
    if (!isAllowedImageUrl(url)) throw new Error("只支持粘贴或上传本地图片");
    input.push({ type: "image", url });
  }
  if (!input.length) throw new Error("请输入文字或粘贴图片");
  return input;
}

export function reviewParams(
  threadId: string,
  target?: ReviewTarget,
  delivery: "inline" | "detached" = "inline",
) {
  const kind = target?.type || "uncommittedChanges";
  let resolved: Record<string, unknown>;
  if (kind === "baseBranch") {
    const branch = target?.branch?.trim();
    if (!branch) throw new Error("请指定要对比的分支，例如 /review base main");
    resolved = { type: "baseBranch", branch };
  } else if (kind === "commit") {
    const sha = target?.sha?.trim();
    if (!sha) throw new Error("请指定要审查的 commit");
    resolved = { type: "commit", sha };
    if (target?.title?.trim()) resolved.title = target.title.trim();
  } else if (kind === "custom") {
    const instructions = target?.instructions?.trim();
    if (!instructions) throw new Error("请填写审查说明");
    resolved = { type: "custom", instructions };
  } else {
    resolved = { type: "uncommittedChanges" };
  }
  return { threadId, delivery, target: resolved };
}
