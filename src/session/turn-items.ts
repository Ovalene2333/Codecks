import { changeKindLabel, displayText, shortenPath } from "../format";

export type TurnRenderEntry =
  | { kind: "item"; item: any }
  | { kind: "fileChangeGroup"; items: any[]; changes: any[] };

export function groupTurnItems(items: any[]): TurnRenderEntry[] {
  const grouped: TurnRenderEntry[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
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
