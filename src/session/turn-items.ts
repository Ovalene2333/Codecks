import { changeKindLabel, displayText, shortenPath } from "../format";

export type TurnRenderEntry =
  | { kind: "item"; item: any }
  | { kind: "fileChangeGroup"; items: any[]; changes: any[] }
  | { kind: "toolGroup"; items: any[]; label: string; files: string[] };

export function reasoningText(item: any) {
  const summary = displayText(item?.summary).trim();
  return summary || displayText(item?.content).trim();
}

export function groupTurnItems(items: any[]): TurnRenderEntry[] {
  const grouped: TurnRenderEntry[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item?.type === "reasoning" && !reasoningText(item)) {
      index += 1;
      continue;
    }
    if (isGroupableEdit(item)) {
      const editItems: any[] = [];
      while (index < items.length && isGroupableEdit(items[index])) {
        editItems.push(items[index]);
        index += 1;
      }
      if (editItems.length > 1) {
        grouped.push({
          kind: "toolGroup",
          items: editItems,
          label: "编辑",
          files: unique(
            editItems.map((entry) => openCodeFileTarget(entry)),
          ),
        });
        continue;
      }
      grouped.push({ kind: "item", item: editItems[0] });
      continue;
    }
    if (item?.type !== "fileChange") {
      grouped.push({ kind: "item", item });
      index += 1;
      continue;
    }

    const fileItems: any[] = [];
    const changes: any[] = [];
    while (index < items.length && items[index]?.type === "fileChange") {
      const fileItem = items[index];
      fileItems.push(fileItem);
      if (Array.isArray(fileItem.changes)) changes.push(...fileItem.changes);
      index += 1;
    }
    grouped.push(
      fileItems.length > 1 || changes.length > 1
        ? { kind: "fileChangeGroup", items: fileItems, changes }
        : { kind: "item", item: fileItems[0] },
    );
  }
  return grouped;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * OpenCode 原生 tool part 经 openCodePartToItem 归一化后是 commandExecution，
 * 文件路径在 state.input.filePath（edit/write/read），成功输出多半是一句
 * "Edit applied successfully."。下面这组 helper 把它们翻译成和 Codex 侧
 * 一致的中文动作，避免时间线里堆满 `已执行 xxx`。
 */
const OPENCODE_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "patch",
  "str_replace",
  "create",
]);
const OPENCODE_READ_TOOLS = new Set(["read"]);
const OPENCODE_EXPLORE_TOOLS = new Set([
  "list",
  "glob",
  "grep",
  "codesearch",
  "search",
]);

function openCodeInputPath(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const row = input as Record<string, unknown>;
  for (const key of [
    "filePath",
    "file_path",
    "file",
    "filename",
    "relativePath",
    "path",
  ]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stripToolVerb(command: string) {
  return command
    .replace(/^(edit|write|read|create|update|apply\s+patch|patch)\s*[:：]?\s+/i, "")
    .trim();
}

/** OpenCode 文件工具的目标文件（已按 cwd 裁剪），拿不到时回落到标题。 */
export function openCodeFileTarget(item: any, cwd?: string): string {
  const input = item?.input ?? item?.arguments;
  const structured =
    openCodeInputPath(input) ||
    openCodeInputPath(item?.metadata) ||
    String(item?.metadata?.filediff?.file || item?.metadata?.file || "").trim();
  if (structured) return shortenPath(structured, cwd);
  const fallback = stripToolVerb(displayText(item?.command));
  // 标题里经常直接就是文件路径；只在看起来像路径时才采用，避免把整句
  // 描述塞进 summary。
  if (fallback && /[\\/]/.test(fallback) && fallback.length <= 180)
    return shortenPath(fallback, cwd);
  if (fallback && /^[\w\-.]+(\.[\w]+)?$/.test(fallback) && fallback.length <= 80)
    return shortenPath(fallback, cwd);
  return "";
}

function openCodeToolName(item: any) {
  return String(item?.tool || item?.name || "").toLowerCase();
}

/** 连续出现时可以收进一个“编辑 N 次”分组的条目：只收文件写入类。 */
export function isGroupableEdit(item: any) {
  return (
    item?.type === "commandExecution" &&
    OPENCODE_EDIT_TOOLS.has(openCodeToolName(item))
  );
}

/** "Edit applied successfully." 这类没有信息量的成功回执，展开时不占一行。 */
export function isTrivialToolOutput(value: unknown) {
  const text = displayText(value).trim();
  if (!text) return true;
  return /^(edit applied successfully|file edited successfully|edit successful|successfully edited|write successful|file written successfully|saved|done|ok|success)[.\s!]*$/i.test(
    text,
  );
}

function readActionTarget(action: any, cwd?: string) {
  return shortenPath(
    String(action?.path || action?.name || action?.command || ""),
    cwd,
  );
}

function toolReadTarget(item: any, cwd?: string) {
  const tool = String(item?.tool || item?.name || "").toLowerCase();
  if (
    !/(^|[_.:/-])(read|readfile|getfile|read_file|get_file)($|[_.:/-])/.test(
      tool,
    )
  )
    return "";
  const input = item?.arguments ?? item?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const row = input as Record<string, unknown>;
  return shortenPath(
    String(
      row.path ||
        row.file ||
        row.filePath ||
        row.file_path ||
        row.filename ||
        "",
    ),
    cwd,
  );
}

export function turnReadTargets(items: any[], cwd?: string) {
  const targets: string[] = [];
  for (const item of items) {
    if (item?.type === "commandExecution") {
      const actions = Array.isArray(item.commandActions)
        ? item.commandActions
        : [];
      for (const action of actions) {
        if (action?.type === "read")
          targets.push(readActionTarget(action, cwd));
      }
      // OpenCode read 工具没有 commandActions，路径在 input.filePath。
      if (actions.length === 0 && openCodeToolName(item) === "read") {
        const target = openCodeFileTarget(item, cwd);
        if (target) targets.push(target);
      }
      continue;
    }
    if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall")
      targets.push(toolReadTarget(item, cwd));
  }
  return unique(targets);
}

export function fileChangeGroupLabel(changes: any[]) {
  const labels = unique(changes.map((change) => changeKindLabel(change?.kind)));
  return labels.length === 1 ? labels[0] : "changes";
}

export function commandPresentation(item: any, cwd?: string) {
  const actions = Array.isArray(item?.commandActions)
    ? item.commandActions.filter(Boolean)
    : [];
  if (actions.length > 0) {
    const hasExplore = actions.some(
      (action: any) => action?.type === "listFiles" || action?.type === "search",
    );
    const isRead =
      actions.length > 0 &&
      actions.every((action: any) => action?.type === "read");
    const kind = hasExplore ? "explore" : isRead ? "read" : "command";
    const targets = unique(
      actions.map((action: any) => {
        if (action?.type === "read") return readActionTarget(action, cwd);
        if (action?.type === "search") {
          const query = String(action.query || "").trim();
          const path = shortenPath(String(action.path || ""), cwd);
          return [query, path].filter(Boolean).join(" · ");
        }
        if (action?.type === "listFiles")
          return shortenPath(String(action.path || action.command || ""), cwd);
        return "";
      }),
    );
    return {
      kind,
      label: kind === "read" ? "读取" : kind === "explore" ? "检索" : "",
      target: targets.join(", "),
    } as const;
  }
  // OpenCode 工具没有 commandActions：按 tool 名翻译中文动作。
  if (item?.type === "commandExecution" && item?.tool) {
    const tool = openCodeToolName(item);
    if (OPENCODE_EDIT_TOOLS.has(tool))
      return {
        kind: "edit",
        label: "编辑",
        target: openCodeFileTarget(item, cwd),
      } as const;
    if (OPENCODE_READ_TOOLS.has(tool))
      return {
        kind: "read",
        label: "读取",
        target: openCodeFileTarget(item, cwd),
      } as const;
    if (OPENCODE_EXPLORE_TOOLS.has(tool)) {
      const input =
        item?.input && typeof item.input === "object" ? item.input : {};
      const pattern = String(
        (input as any)?.pattern || (input as any)?.query || "",
      ).trim();
      const path = openCodeFileTarget(item, cwd);
      return {
        kind: "explore",
        label: "检索",
        target: [pattern, path].filter(Boolean).join(" · "),
      } as const;
    }
  }
  return { kind: "command", label: "", target: "" } as const;
}

function jsonText(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) || "";
  } catch {
    return String(value);
  }
}

export function toolCallPresentation(item: any) {
  const tool = String(item?.tool || item?.name || item?.type || "tool");
  const scope = String(item?.server || item?.namespace || "");
  const input = jsonText(item?.arguments ?? item?.input);
  const output =
    displayText(item?.error?.message) ||
    displayText(item?.result?.content) ||
    displayText(item?.contentItems) ||
    jsonText(item?.result?.structuredContent) ||
    jsonText(item?.result) ||
    jsonText(item?.output);
  return { tool, scope, input, output };
}
