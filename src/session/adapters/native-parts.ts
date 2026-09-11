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

/** Bash/shell 类工具的真实命令在 state.input.command 里，state.title 经常只是
 * 泛称（甚至缺失），直接用它做 command 会展示成“正在执行 bash”且点开展示空。
 * 与服务端 openCodePartToItem 保持一致：优先取 input 里的实际命令。 */
export function openCodeShellCommand(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const row = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "text", "commands"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

const OPENCODE_SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "exec",
  "execute",
  "command",
  "run",
  "sh",
  "terminal",
  "process",
]);

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
    if (part.tool === "task") {
      const input =
        state.input && typeof state.input === "object" ? state.input : {};
      const childSessionId = String(state.metadata?.sessionId || "").trim();
      return {
        id: String(part.id),
        type: "subagent",
        title: String(input.description || state.title || part.tool).trim(),
        agent: String(
          input.subagent_type || input.agent || input.agentType || "",
        ).trim(),
        status:
          state.status === "error"
            ? "failed"
            : state.status === "completed"
              ? "completed"
              : "inProgress",
        activity: String(state.metadata?.deckActivity || ""),
        aggregatedOutput: state.output || state.error || "",
        ...(childSessionId ? { childSessionId } : {}),
      };
    }
    const toolName = String(part.tool || "").toLowerCase();
    const shellCommand = openCodeShellCommand(state.input);
    const command =
      (OPENCODE_SHELL_TOOLS.has(toolName) && shellCommand) ||
      shellCommand ||
      state.title ||
      part.tool ||
      "OpenCode 工具";
    const description = String(
      (state.input as any)?.description || "",
    ).trim();
    const item: any = {
      id: String(part.id),
      type: "commandExecution",
      command,
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
      ...(description && description !== String(command || "").trim()
        ? { description }
        : {}),
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
