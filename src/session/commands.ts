import type { ReviewTarget } from "../types";

export type ComposerCommand =
  | { kind: "compact" }
  | { kind: "init" }
  | { kind: "diff" }
  | { kind: "status" }
  | { kind: "plan" }
  | { kind: "goal"; objective: string }
  | { kind: "goal-clear" }
  | { kind: "review"; target: ReviewTarget }
  | { kind: "shell"; command: string };

export const SLASH_COMMANDS = [
  { name: "/compact", hint: "压缩上下文" },
  { name: "/review", hint: "审查未提交改动" },
  { name: "/init", hint: "生成或更新 AGENTS.md" },
  { name: "/diff", hint: "查看 git 工作区改动" },
  { name: "/plan", hint: "只规划、不改代码" },
  { name: "/goal", hint: "设置本会话目标" },
  { name: "/status", hint: "查看会话配置" },
  { name: "!", hint: "无沙箱执行命令" },
] as const;

export function parseComposerCommand(
  raw: string,
): ComposerCommand | undefined {
  const text = raw.trim();
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { kind: "shell", command } : undefined;
  }
  if (!text.startsWith("/")) return undefined;
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  const key = match[1].toLowerCase();
  const arg = (match[2] || "").trim();
  if (key === "compact") return { kind: "compact" };
  if (key === "init") return { kind: "init" };
  if (key === "diff") return { kind: "diff" };
  if (key === "status") return { kind: "status" };
  if (key === "plan") return { kind: "plan" };
  if (key === "goal") {
    if (!arg) return undefined;
    if (arg.toLowerCase() === "clear") return { kind: "goal-clear" };
    return { kind: "goal", objective: arg };
  }
  if (key === "review") {
    if (!arg) return { kind: "review", target: { type: "uncommittedChanges" } };
    const [head, ...rest] = arg.split(/\s+/);
    if (head.toLowerCase() === "base" && rest[0])
      return {
        kind: "review",
        target: { type: "baseBranch", branch: rest.join(" ") },
      };
    if (head.toLowerCase() === "commit" && rest[0])
      return {
        kind: "review",
        target: {
          type: "commit",
          sha: rest[0],
          title: rest.slice(1).join(" ") || undefined,
        },
      };
    return { kind: "review", target: { type: "custom", instructions: arg } };
  }
  return undefined;
}

export function matchingSlashCommands(text: string) {
  const value = text.trim();
  if (!value) return [];
  if (value === "!")
    return SLASH_COMMANDS.filter((item) => item.name === "!");
  if (!value.startsWith("/")) return [];
  const query = value.toLowerCase();
  const items = SLASH_COMMANDS.filter((item) => item.name.startsWith(query));
  if (value === "/")
    return [
      ...items,
      ...SLASH_COMMANDS.filter((item) => item.name === "!"),
    ];
  return items;
}

export function incompleteCommandHint(raw: string) {
  const text = raw.trim();
  if (text === "!") return "用法：!git status  在无沙箱下执行命令";
  if (/^\/goal$/i.test(text)) return "用法：/goal <目标>  或 /goal clear";
  if (/^\/review\s+base$/i.test(text))
    return "用法：/review base <分支>";
  if (/^\/review\s+commit$/i.test(text))
    return "用法：/review commit <sha>";
  return "";
}
