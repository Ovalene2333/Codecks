import type { AgentUiAdapter } from "./types";
import { TodoPanel } from "./todos";

/**
 * 通用 ACP agent 的 UI adapter。ACP 的工具调用在服务端已归一化为
 * commandExecution/fileChange/dynamicToolCall，这里只补 plan（todo）
 * 扩展项的渲染；其余返回 undefined 落到通用兜底。
 */
export const acpAdapter: AgentUiAdapter = {
  renderItem(item) {
    if (item?.type === "extension" && item.kind === "todo") {
      const todos = Array.isArray(item.payload?.todos)
        ? item.payload.todos
        : [];
      return <TodoPanel todos={todos} title="计划" />;
    }
    return undefined;
  },
};
