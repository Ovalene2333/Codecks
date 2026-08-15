import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ThreadSummary, TokenUsage } from "../types.js";

type ClaudeRecord = Record<string, any>;

export interface ClaudeHistoryThread {
  summary: ThreadSummary;
  thread: {
    id: string;
    cwd: string;
    model: string;
    turns: any[];
    tokenUsage?: TokenUsage;
  };
}

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function contentParts(record: ClaudeRecord): ClaudeRecord[] {
  return Array.isArray(record.message?.content) ? record.message.content : [];
}

function mainChain(records: ClaudeRecord[]) {
  const messages = records.filter(
    (record) =>
      (record.type === "user" || record.type === "assistant") && record.uuid,
  );
  const byId = new Map(messages.map((record) => [record.uuid, record]));
  const declaredLeaf = [...records]
    .reverse()
    .find((record) => record.type === "last-prompt")?.leafUuid;
  let current =
    (declaredLeaf && byId.get(declaredLeaf)) || messages.at(-1) || undefined;
  const chain: ClaudeRecord[] = [];
  const seen = new Set<string>();
  while (current?.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byId.get(current.parentUuid) : undefined;
  }
  return chain.reverse();
}

function usageFrom(records: ClaudeRecord[]): TokenUsage | undefined {
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let used = 0;
  let modelLimit: number | undefined;
  let found = false;
  const seen = new Set<string>();
  for (const record of records) {
    const usage = record.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const usageId = record.message?.id;
    if (usageId && seen.has(usageId)) continue;
    if (usageId) seen.add(usageId);
    found = true;
    const direct = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const produced = Number(usage.output_tokens) || 0;
    input += direct + cacheCreate;
    cachedInput += cacheRead;
    output += produced;
    used = direct + cacheRead + cacheCreate + produced;
    const context = Number(usage.context_window);
    if (Number.isFinite(context) && context > 0) modelLimit = context;
  }
  if (!found) return undefined;
  return {
    total: input + cachedInput + output,
    used,
    ...(modelLimit ? { limit: modelLimit } : {}),
    input,
    cachedInput,
    output,
  };
}

function toolItem(part: ClaudeRecord, record: ClaudeRecord) {
  const id = String(part.id || record.uuid);
  const input = part.input && typeof part.input === "object" ? part.input : {};
  if (part.name === "Bash")
    return {
      id,
      type: "commandExecution",
      command: String(input.command || "Bash"),
      status: "inProgress",
      aggregatedOutput: "",
    };
  if (["Edit", "Write", "NotebookEdit"].includes(part.name))
    return {
      id,
      type: "fileChange",
      status: "inProgress",
      changes: [
        {
          path: String(input.file_path || input.notebook_path || ""),
          kind: part.name === "Write" ? "add" : "update",
        },
      ],
    };
  const detail = Object.keys(input).length ? ` ${JSON.stringify(input)}` : "";
  return {
    id,
    type: "commandExecution",
    command: `${part.name || "Tool"}${detail}`,
    status: "inProgress",
    aggregatedOutput: "",
  };
}

function normalizeTurns(chain: ClaudeRecord[]) {
  const turns: any[] = [];
  const tools = new Map<string, any>();
  let current: any | undefined;
  for (const record of chain) {
    const parts = contentParts(record);
    const toolResults = parts.filter((part) => part?.type === "tool_result");
    const userText = textContent(record.message?.content);
    const isUserPrompt =
      record.type === "user" &&
      toolResults.length === 0 &&
      !record.isMeta &&
      !record.isSynthetic;
    if (isUserPrompt) {
      current = {
        id: String(record.uuid),
        status: "completed",
        startedAt: record.timestamp,
        items: [
          {
            id: String(record.uuid),
            type: "userMessage",
            content: [{ type: "text", text: userText }],
          },
        ],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (record.type === "assistant") {
      if (record.message?.model) current.model = record.message.model;
      parts.forEach((part, index) => {
        if (part?.type === "text" && part.text)
          current.items.push({
            id: `${record.uuid}:${index}`,
            type: "agentMessage",
            text: part.text,
          });
        else if (part?.type === "thinking" && part.thinking)
          current.items.push({
            id: `${record.uuid}:${index}`,
            type: "reasoning",
            summary: part.thinking,
          });
        else if (part?.type === "tool_use") {
          const item = toolItem(part, record);
          tools.set(String(part.id), item);
          current.items.push(item);
        }
      });
      continue;
    }
    for (const result of toolResults) {
      const item = tools.get(String(result.tool_use_id));
      if (!item) continue;
      item.status = result.is_error ? "failed" : "completed";
      const output =
        textContent(result.content) ||
        (typeof result.content === "string" ? result.content : "");
      if (item.type === "commandExecution") item.aggregatedOutput = output;
    }
  }
  return turns;
}

function cleanPreview(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeHistory(
  source: string,
  filePath: string,
  fallbackUpdatedAt = Date.now(),
): ClaudeHistoryThread | undefined {
  const records = source
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeRecord];
      } catch {
        return [];
      }
    });
  const chain = mainChain(records);
  const sessionId = String(
    chain[0]?.sessionId ||
      records.find((record) => record.sessionId)?.sessionId ||
      path.basename(filePath, ".jsonl"),
  );
  if (!sessionId || !chain.length) return undefined;
  const turns = normalizeTurns(chain);
  const firstUser = turns[0]?.items?.find(
    (item: any) => item.type === "userMessage",
  );
  const preview = cleanPreview(
    textContent(firstUser?.content) || "Claude Code 会话",
  );
  const titleRecord = [...records]
    .reverse()
    .find(
      (record) =>
        (record.type === "custom-title" || record.type === "ai-title") &&
        (record.customTitle || record.aiTitle || record.title),
    );
  const last = chain.at(-1);
  const cwd = String(last?.cwd || chain[0]?.cwd || "");
  const model = String(
    [...chain].reverse().find((record) => record.message?.model)?.message
      ?.model || "default",
  );
  const updatedAt = Date.parse(last?.timestamp || "") || fallbackUpdatedAt;
  const tokenUsage = usageFrom(chain);
  const summary: ThreadSummary = {
    agentId: "claude",
    id: sessionId,
    providerId: "claude-current",
    name: String(
      titleRecord?.customTitle ||
        titleRecord?.aiTitle ||
        titleRecord?.title ||
        preview.slice(0, 42),
    ),
    preview,
    cwd,
    model,
    status: "idle",
    updatedAt,
    sessionId,
    tokenUsage,
    controlMode: "history",
  };
  return {
    summary,
    thread: { id: sessionId, cwd, model, turns, tokenUsage },
  };
}

export async function readClaudeHistory(filePath: string) {
  const [source, info] = await Promise.all([
    readFile(filePath, "utf8"),
    stat(filePath),
  ]);
  return parseClaudeHistory(source, filePath, info.mtimeMs);
}
