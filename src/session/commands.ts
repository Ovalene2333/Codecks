import type { AgentId, ReviewTarget } from "../types";

export type ComposerCommand =
  | { kind: "compact" }
  | { kind: "init" }
  | { kind: "diff" }
  | { kind: "status" }
  | { kind: "ps" }
  | { kind: "usage" }
  | { kind: "model"; model?: string; reasoningEffort?: string }
  | { kind: "permissions"; sandbox?: string; approvalMode?: string }
  | { kind: "skills"; query: string }
  | { kind: "mention"; query: string }
  | { kind: "fast"; enabled?: boolean }
  | { kind: "mcp"; verbose: boolean }
  | { kind: "plan" }
  | { kind: "goal"; objective: string }
  | { kind: "goal-clear" }
  | { kind: "review"; target: ReviewTarget }
  | { kind: "shell"; command: string }
  | { kind: "opencode-command"; command: string; args: string }
  | { kind: "agent-command"; command: string; args: string }
  | { kind: "new-session" }
  | { kind: "sessions" }
  | { kind: "thinking" }
  | { kind: "details" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "help" };

export const SLASH_COMMANDS = [
  { name: "/model", hint: "选择模型与推理强度" },
  { name: "/permissions", hint: "调整沙箱与审批策略" },
  { name: "/skills", hint: "查看并引用可用 Skill" },
  { name: "/status", hint: "查看完整会话状态" },
  { name: "/ps", hint: "查看运行任务与后台终端" },
  { name: "/usage", hint: "查看账号额度" },
  { name: "/mention", hint: "搜索并引用工作区文件" },
  { name: "/fast", hint: "切换 Fast 模式" },
  { name: "/mcp", hint: "查看 MCP 服务器状态" },
  { name: "/compact", hint: "压缩上下文" },
  { name: "/review", hint: "审查未提交改动" },
  { name: "/init", hint: "生成或更新 AGENTS.md" },
  { name: "/diff", hint: "查看 git 工作区改动" },
  { name: "/plan", hint: "只规划、不改代码" },
  { name: "/goal", hint: "设置本会话目标" },
  { name: "!", hint: "无沙箱执行命令" },
] as const;

const PANEL_COMMANDS = new Set([
  "/model",
  "/models",
  "/permissions",
  "/skills",
  "/mention",
  "/mcp",
]);

export function opensCommandPanel(name: string) {
  return PANEL_COMMANDS.has(name.toLowerCase());
}

export function parseComposerCommand(
  raw: string,
  agentId: AgentId = "codex",
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
  if (agentId === "opencode") return parseOpenCodeCommand(key, arg);
  // ACP 等通用 agent：斜杠命令原样透传，由 agent 自己解释；/model 例外，
  // agent 暴露模型目录（configOptions/models spec）时走 Deck 的模型面板，
  // 没有目录时再回落为透传文本。
  if (agentId !== "codex" && agentId !== "claude") {
    if (key === "model" || key === "models")
      return { kind: "model", model: arg || undefined };
    return { kind: "agent-command", command: key, args: arg };
  }
  if (key === "compact") return { kind: "compact" };
  if (key === "init") return { kind: "init" };
  if (key === "diff") return { kind: "diff" };
  if (key === "status") return { kind: "status" };
  if (key === "ps") return { kind: "ps" };
  if (key === "usage") return { kind: "usage" };
  // Model changes must go through the picker. Treating arbitrary text after
  // `/model` as a model id can poison the thread and only fail on its next turn.
  if (key === "model") return { kind: "model" };
  if (key === "permissions") {
    const [sandbox, approvalMode] = arg.split(/\s+/).filter(Boolean);
    return { kind: "permissions", sandbox, approvalMode };
  }
  if (key === "skills") return { kind: "skills", query: arg };
  if (key === "mention") return { kind: "mention", query: arg };
  if (key === "fast") {
    if (!arg) return { kind: "fast" };
    if (["on", "true", "1"].includes(arg.toLowerCase()))
      return { kind: "fast", enabled: true };
    if (["off", "false", "0"].includes(arg.toLowerCase()))
      return { kind: "fast", enabled: false };
    return undefined;
  }
  if (key === "mcp") {
    if (arg && arg.toLowerCase() !== "verbose") return undefined;
    return { kind: "mcp", verbose: arg.toLowerCase() === "verbose" };
  }
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

const CLAUDE_COMMANDS = new Set(["/status", "/usage", "/ps"]);

/** P0 OpenCode 内置命令（`/` 补全用；自定义命令运行时从服务端追加）。 */
export const OPENCODE_COMMANDS = [
  { name: "/compact", hint: "压缩上下文（summarize）" },
  { name: "/undo", hint: "撤回最近一轮（含文件恢复，需确认）" },
  { name: "/redo", hint: "恢复已撤回的内容（需确认）" },
  { name: "/init", hint: "生成或更新 AGENTS.md" },
  { name: "/models", hint: "选择模型" },
  { name: "/new", hint: "新建会话（回到列表创建）" },
  { name: "/sessions", hint: "在左侧列表切换会话" },
  { name: "/details", hint: "工具执行细节（可展开查看）" },
  { name: "/thinking", hint: "思考过程（默认折叠显示）" },
  { name: "/status", hint: "查看完整会话状态" },
  { name: "/ps", hint: "查看运行任务" },
  { name: "/usage", hint: "查看用量统计" },
  { name: "/help", hint: "查看 OpenCode 命令帮助" },
] as const;

export type SlashMenuItem = { name: string; hint: string };

function parseOpenCodeCommand(key: string, arg: string): ComposerCommand {
  if (key === "compact" || key === "summarize") return { kind: "compact" };
  if (key === "undo") return { kind: "undo" };
  if (key === "redo") return { kind: "redo" };
  if (key === "model" || key === "models") return { kind: "model" };
  if (key === "status") return { kind: "status" };
  if (key === "ps") return { kind: "ps" };
  if (key === "usage") return { kind: "usage" };
  if (key === "new" || key === "clear") return { kind: "new-session" };
  if (key === "sessions" || key === "resume" || key === "continue")
    return { kind: "sessions" };
  if (key === "thinking") return { kind: "thinking" };
  if (key === "details") return { kind: "details" };
  if (key === "help") return { kind: "help" };
  // 其余一律透传给 `POST /session/:id/command`（内置 init/share 等与
  // `.opencode/commands/*.md` 自定义命令），服务端会校验是否存在。
  return { kind: "opencode-command", command: key, args: arg };
}

export function matchingSlashCommands(
  text: string,
  agentId: AgentId = "codex",
  extraCommands: Array<{ name: string; hint?: string }> = [],
) {
  const value = text.trim();
  if (!value) return [];
  if (value === "!") return SLASH_COMMANDS.filter((item) => item.name === "!");
  if (!value.startsWith("/")) return [];
  const query = value.toLowerCase();
  // ACP 等通用 agent：只补全 agent 自报的 availableCommands。
  if (agentId !== "codex" && agentId !== "claude" && agentId !== "opencode") {
    const seen = new Set<string>();
    const items: SlashMenuItem[] = [];
    for (const extra of extraCommands) {
      const raw = String(extra?.name || "").trim();
      if (!raw) continue;
      const name = raw.startsWith("/") ? raw : `/${raw}`;
      if (!name.toLowerCase().startsWith(query) || seen.has(name)) continue;
      seen.add(name);
      items.push({
        name,
        hint: String(extra?.hint || "Agent 命令").slice(0, 80),
      });
    }
    return items;
  }
  if (agentId === "opencode") {
    const seen = new Set<string>();
    const items: SlashMenuItem[] = [];
    for (const item of [...OPENCODE_COMMANDS]) {
      if (item.name.startsWith(query) && !seen.has(item.name)) {
        seen.add(item.name);
        items.push({ name: item.name, hint: item.hint });
      }
    }
    for (const extra of extraCommands) {
      const raw = String(extra?.name || "").trim();
      if (!raw) continue;
      const name = raw.startsWith("/") ? raw : `/${raw}`;
      if (!name.toLowerCase().startsWith(query) || seen.has(name)) continue;
      seen.add(name);
      items.push({
        name,
        hint: String(extra?.hint || "自定义命令").slice(0, 80),
      });
    }
    return items;
  }
  const items = SLASH_COMMANDS.filter(
    (item) =>
      item.name.startsWith(query) &&
      (agentId === "codex" || CLAUDE_COMMANDS.has(item.name)),
  );
  if (value === "/")
    return agentId === "codex"
      ? [...items, ...SLASH_COMMANDS.filter((item) => item.name === "!")]
      : items;
  return items;
}

export function incompleteCommandHint(raw: string) {
  const text = raw.trim();
  if (text === "!") return "用法：!git status  在无沙箱下执行命令";
  if (/^\/goal$/i.test(text)) return "用法：/goal <目标>  或 /goal clear";
  if (
    /^\/fast\s+/i.test(text) &&
    !/^\/fast\s+(on|off|true|false|1|0)$/i.test(text)
  )
    return "用法：/fast [on|off]";
  if (/^\/mcp\s+/i.test(text) && !/^\/mcp\s+verbose$/i.test(text))
    return "用法：/mcp [verbose]";
  if (/^\/review\s+base$/i.test(text)) return "用法：/review base <分支>";
  if (/^\/review\s+commit$/i.test(text)) return "用法：/review commit <sha>";
  return "";
}
