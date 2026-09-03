/**
 * Pure helpers shared by the per-agent UI adapters and the streaming
 * collector. They mirror the normalization rules implemented server-side
 * (server/agents/opencode-adapter.ts, claude-history.ts) so raw native data
 * streamed over WebSocket can be converted without another round trip.
 */

/** Todos attached to an OpenCode tool item (state.input / state.metadata). */
export function openCodeTodos(item: any): any[] {
  const sources = [
    item?.metadata?.todos,
    item?.input?.todos,
    item?.input?.items,
    Array.isArray(item?.todos) ? item.todos : undefined,
  ];
  for (const source of sources) {
    if (Array.isArray(source) && source.length)
      return source
        .filter(Boolean)
        .map((todo: any) =>
          typeof todo === "string"
            ? { content: todo }
            : {
                ...todo,
                content: String(todo.content ?? todo.text ?? todo.title ?? ""),
              },
        );
  }
  return [];
}

/** Converts a raw OpenCode message part into the shared turn item shape. */
export function openCodePartToItem(part: any): any | undefined {
  if (!part?.type && !part?.tool) return undefined;
  if (
    ["step-start", "step-finish", "snapshot", "patch"].includes(
      String(part.type),
    )
  )
    return undefined;
  if (part.type === "text")
    return { id: String(part.id), type: "agentMessage", text: part.text || "" };
  if (part.type === "reasoning")
    return { id: String(part.id), type: "reasoning", summary: part.text || "" };
  if (part.type === "tool") {
    const state = part.state || {};
    const item: any = {
      id: String(part.id),
      type: "commandExecution",
      command: state.title || part.tool || "OpenCode 工具",
      status:
        state.status === "error"
          ? "failed"
          : state.status === "completed"
            ? "completed"
            : "inProgress",
      aggregatedOutput: state.output || state.error || "",
      ...(part.tool ? { tool: part.tool } : {}),
      ...(state.input != null ? { input: state.input } : {}),
      ...(state.metadata != null ? { metadata: state.metadata } : {}),
    };
    const todos = openCodeTodos(item);
    if (todos.length) item.todos = todos;
    return item;
  }
  if (part.type === "file") return undefined;
  return {
    id: String(part.id),
    type: "extension",
    kind: String(part.type || "unknown"),
    agentId: "opencode",
    payload: part,
  };
}

/** Todos carried by Claude's TodoWrite input or a todo extension payload. */
export function claudeTodos(input: any): any[] {
  const todos = input?.todos ?? input?.payload?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter(Boolean)
    .map((todo: any) =>
      typeof todo === "string"
        ? { content: todo }
        : {
            ...todo,
            content: String(todo.content ?? todo.text ?? todo.title ?? ""),
          },
    );
}

export type TodoState = "completed" | "inProgress" | "pending";

export function todoState(todo: any): TodoState {
  const status = String(todo?.status ?? "").toLowerCase();
  if (
    status === "completed" ||
    status === "done" ||
    todo?.completed === true ||
    todo?.checked === true
  )
    return "completed";
  if (
    ["in_progress", "inprogress", "running", "active", "doing"].includes(
      status,
    )
  )
    return "inProgress";
  return "pending";
}
