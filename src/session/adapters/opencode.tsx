import type { AgentUiAdapter } from "./types";
import { openCodeTodos, openCodePartToItem } from "./native-parts";
import { TodoPanel } from "./todos";
import { AssistantMarkdown } from "../markdown";

function todoPayload(item: any): any[] {
  const payload = item?.payload;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.todos)) return payload.todos;
  if (Array.isArray(payload?.items))
    return payload.items.map((todo: any) =>
      typeof todo === "string" ? { content: todo } : todo,
    );
  return [];
}

export const openCodeAdapter: AgentUiAdapter = {
  renderItem(item: any) {
    if (item?.type === "contextCompaction")
      return (
        <details className="tool-row context-compaction">
          <summary>上下文已压缩{item.text ? " · 查看摘要" : ""}</summary>
          {item.text ? <div><AssistantMarkdown text={item.text} /></div> : null}
        </details>
      );
    if (item?.type === "extension") {
      if (/^todo/i.test(item.kind || "")) {
        const todos = todoPayload(item);
        if (todos.length) return <TodoPanel todos={todos} />;
      }
      // Unrecognized native part: render it collapsed like UnknownItem,
      // but keep the marker so the agent pipeline is visibly in play.
      return undefined;
    }
    if (item?.type === "commandExecution") {
      const todos = openCodeTodos(item);
      if (todos.length) return <TodoPanel todos={todos} title="待办事项" />;
    }
    return undefined;
  },
};

export { openCodePartToItem };
