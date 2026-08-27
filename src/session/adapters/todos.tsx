import { Check, Circle, ListTodo } from "lucide-react";
import { todoState } from "./native-parts";

/**
 * Shared todo checklist used by the per-agent adapters (Claude TodoWrite,
 * OpenCode todo tools/parts). Todos follow the tolerant
 * `{ content, status?, activeForm? }` shape produced by native-parts.
 */
export function TodoPanel({
  todos,
  title = "任务清单",
}: {
  todos: any[];
  title?: string;
}) {
  const normalized = todos.filter((todo) => String(todo?.content || "").trim());
  if (!normalized.length) return null;
  const completed = normalized.filter(
    (todo) => todoState(todo) === "completed",
  ).length;
  const allDone = completed === normalized.length;
  return (
    <div className={`tool-row todo-row ${allDone ? "ok" : "running"}`}>
      <div className="todo-head">
        <ListTodo />
        <span className="tool-action">{title}</span>
        <span className="todo-progress">
          {completed}/{normalized.length}
        </span>
      </div>
      <ul className="todo-list">
        {normalized.map((todo, index) => {
          const state = todoState(todo);
          return (
            <li key={`${index}-${todo.content}`} className={`todo-item ${state}`}>
              {state === "completed" ? (
                <Check />
              ) : state === "inProgress" ? (
                <Circle className="in-progress-dot" />
              ) : (
                <Circle />
              )}
              <span>
                {state === "inProgress" && todo.activeForm
                  ? todo.activeForm
                  : todo.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
