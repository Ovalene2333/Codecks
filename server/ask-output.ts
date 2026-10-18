/** 只提取交付文本与可读执行输出，不把推理或整个原生历史复制到台账。 */
export const ASK_OUTPUT_LIMIT = 80_000;

export interface AskResult {
  turnId: string;
  text: string;
  completedAt: number;
  truncated: boolean;
}

export function finalAnswer(turn: any): string {
  const items: any[] = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items.filter((item: any) =>
    item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim(),
  );
  const finals = messages.filter((item: any) => item.phase === "final_answer");
  if (finals.length) return finals.map((item: any) => item.text).join("\n\n").trim();
  // 无 phase 的后端可能把最终答复拆成多个文本块；仅收尾部答复，排除工具前的进度。
  const tail: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "reasoning") continue;
    if (item?.type !== "agentMessage" || item.phase) break;
    if (typeof item.text === "string" && item.text.trim()) tail.unshift(item.text);
  }
  return tail.join("\n\n").trim();
}

export function inspectOutput(turns: any[], tail: number) {
  const chunks: string[] = [];
  for (const turn of turns) {
    chunks.push(`[turn:${turn.id}] ${turn.status || "unknown"}`);
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item?.type === "agentMessage" && typeof item.text === "string") chunks.push(item.text);
      if (item?.type === "commandExecution") {
        if (typeof item.command === "string") chunks.push(`$ ${item.command}`);
        if (typeof item.aggregatedOutput === "string") chunks.push(item.aggregatedOutput);
      }
      if (item?.type === "fileChange" && Array.isArray(item.changes))
        chunks.push(...item.changes.map((change: any) => `[file] ${change.path || ""}`));
    }
  }
  const lines = chunks.join("\n").split("\n");
  const output = lines.slice(-tail).join("\n");
  return { output: output.slice(-ASK_OUTPUT_LIMIT), truncated: lines.length > tail || output.length > ASK_OUTPUT_LIMIT };
}
