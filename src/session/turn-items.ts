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
      if (action?.type === "read")
        return shortenPath(
          String(action.path || action.name || action.command || ""),
          cwd,
        );
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
    label: kind === "command" ? "" : kind,
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
