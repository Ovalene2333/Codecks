import type {
  ActiveTask,
  ActiveTaskCommand,
  BackgroundTerminal,
  ThreadSummary,
} from "./types.js";

function runningCommands(thread: any): ActiveTaskCommand[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const active =
    turns.find((turn: any) => turn?.id === thread?.activeTurnId) ||
    [...turns]
      .reverse()
      .find((turn: any) =>
        ["inProgress", "running"].includes(String(turn?.status)),
      ) ||
    turns.at(-1);
  if (!active || !Array.isArray(active.items)) return [];
  return active.items
    .filter(
      (item: any) =>
        item?.type === "commandExecution" &&
        ["inProgress", "running"].includes(String(item?.status)),
    )
    .map((item: any) => ({
      itemId: item.id ? String(item.id) : undefined,
      processId: item.processId ? String(item.processId) : undefined,
      command: String(item.command || "正在执行命令"),
      cwd: item.cwd ? String(item.cwd) : undefined,
      status: "running" as const,
    }));
}

function mergeCommands(
  commands: ActiveTaskCommand[],
  terminals: BackgroundTerminal[],
) {
  const merged = new Map<string, ActiveTaskCommand>();
  for (const command of commands) {
    const key = command.processId || command.itemId || command.command;
    merged.set(key, command);
  }
  for (const terminal of terminals) {
    const key = terminal.processId || terminal.itemId || terminal.command;
    merged.set(key, { ...merged.get(key), ...terminal, status: "background" });
  }
  return [...merged.values()];
}

export function activeTask(
  summary: ThreadSummary,
  thread: any,
  terminals: BackgroundTerminal[],
  processControl: boolean,
  detailError?: string,
): ActiveTask {
  return {
    id: `${summary.agentId || "codex"}:${summary.id}`,
    agentId: summary.agentId || "codex",
    providerId: summary.providerId,
    threadId: summary.id,
    threadName: summary.name,
    turnId: summary.activeTurnId,
    cwd: summary.cwd,
    model: summary.model,
    status: summary.status === "waiting" ? "waiting" : "running",
    startedAt: summary.updatedAt,
    commands: mergeCommands(runningCommands(thread), terminals),
    processControl,
    detailError,
  };
}
