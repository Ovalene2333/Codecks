import { displayText } from "../../format";
import type { AgentItemContext, AgentUiAdapter } from "./types";
import { claudeTodos, openCodeTodos } from "./native-parts";
import { TodoPanel } from "./todos";

/** Claude writes todos as `TodoWrite {json}` command rows in old histories. */
function legacyTodoList(item: any): any[] {
  const command = displayText(item?.command);
  if (!/^TodoWrite\b/.test(command.trim())) return [];
  try {
    return claudeTodos(JSON.parse(command.replace(/^TodoWrite\s*/, "")));
  } catch {
    return [];
  }
}

export const claudeAdapter: AgentUiAdapter = {
  renderItem(item: any, _context: AgentItemContext) {
    if (item?.type === "extension") {
      const todos = claudeTodos(item.payload);
      if (item.kind === "todo" && todos.length)
        return <TodoPanel todos={todos} />;
      return undefined;
    }
    if (item?.type === "commandExecution") {
      const todos = openCodeTodos(item).length
        ? openCodeTodos(item)
        : legacyTodoList(item);
      if (todos.length) return <TodoPanel todos={todos} title="待办事项" />;
    }
    return undefined;
  },
};
