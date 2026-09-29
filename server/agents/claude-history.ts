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
  // Claude Code >=2.1 会把 attachment/system 记录编进 parentUuid 链，
  // compact_boundary 之后还会另起一条 parentUuid=null 的新链。因此先按
  // 链根分组，再从每段最后一条记录向前回溯，沿途只收集主线上的
  // user/assistant；sidechain（Task 子代理）只穿过不收集。
  const byUuid = new Map<string, ClaudeRecord>();
  for (const record of records)
    if (record.uuid) byUuid.set(record.uuid, record);
  const rootOf = new Map<string, string>();
  const rootFor = (record: ClaudeRecord) => {
    const known = rootOf.get(record.uuid);
    if (known) return known;
    let current: ClaudeRecord | undefined = record;
    const trail: string[] = [];
    const seen = new Set<string>();
    while (current?.uuid && !seen.has(current.uuid)) {
      const memoized = rootOf.get(current.uuid);
      if (memoized) {
        current = { uuid: memoized };
        break;
      }
      seen.add(current.uuid);
      trail.push(current.uuid);
      current = current.parentUuid
        ? byUuid.get(current.parentUuid)
        : undefined;
    }
    const root = current?.uuid || trail.at(-1) || record.uuid;
    for (const uuid of trail) rootOf.set(uuid, root);
    return root;
  };
  // 每个链根的规范叶节点取该链在文件里的最后一条记录：文件本身是追加写的，
  // 尾部即最新主链末梢；被丢弃的重试分支不在这条回溯路径上。
  const leaves = new Map<string, ClaudeRecord>();
  for (const record of records) {
    if (!record.uuid) continue;
    leaves.set(rootFor(record), record);
  }
  const chain: ClaudeRecord[] = [];
  for (const [root, leaf] of leaves) {
    const segment: ClaudeRecord[] = [];
    const seen = new Set<string>();
    let current: ClaudeRecord | undefined = leaf;
    while (
      current?.uuid &&
      !seen.has(current.uuid) &&
      rootOf.get(current.uuid) === root
    ) {
      seen.add(current.uuid);
      if (
        (current.type === "user" || current.type === "assistant") &&
        !current.isSidechain
      )
        segment.push(current);
      current = current.parentUuid
        ? byUuid.get(current.parentUuid)
        : undefined;
    }
    chain.push(...segment.reverse());
  }
  return chain;
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

export function claudeTodos(input: any): any[] {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter(Boolean)
    .map((todo: any) =>
      typeof todo === "string"
        ? { content: todo }
        : { ...todo, content: String(todo.content ?? todo.text ?? todo.title ?? "") },
    );
}

export function claudeToolItem(part: ClaudeRecord, record: ClaudeRecord) {
  const id = String(part.id || record.uuid);
  const input = part.input && typeof part.input === "object" ? part.input : {};
  if (part.name === "TodoWrite") {
    const todos = claudeTodos(input);
    if (todos.length)
      return {
        id,
        type: "extension",
        kind: "todo",
        agentId: "claude",
        status: "inProgress",
        payload: { todos },
      };
  }
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
    ...(part.name && part.name !== "Bash" ? { tool: part.name } : {}),
    ...(Object.keys(input).length ? { input } : {}),
  };
}

function isUserPromptRecord(record: ClaudeRecord) {
  const parts = contentParts(record);
  return (
    record.type === "user" &&
    !record.isMeta &&
    !record.isSynthetic &&
    !record.isSidechain &&
    parts.every((part) => part?.type !== "tool_result")
  );
}

function parseRecords(source: string) {
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeRecord];
      } catch {
        return [];
      }
    });
}

/**
 * 回滚锚点：turnUuid 是主链上某个 user prompt 的 uuid（即 turns 里的
 * turn.id）。返回该 prompt 之前最后一条主链消息的 uuid——以此为界截断
 * 文件即 Claude Code rewind/fork 的语义：目标 turn 及其后所有记录留在
 * 原文件里成为孤儿分支。null = 目标是首条消息（回滚到会话开头）；
 * undefined = 该 uuid 不是当前主链上的 prompt（已被回退或传错）。
 */
export function rewindAnchorUuid(
  source: string,
  turnUuid: string,
): string | null | undefined {
  const chain = mainChain(parseRecords(source));
  const index = chain.findIndex(
    (record) => record.uuid === turnUuid && isUserPromptRecord(record),
  );
  if (index < 0) return undefined;
  const anchor = chain[index - 1];
  return anchor?.uuid ? String(anchor.uuid) : null;
}

/**
 * turn 末尾锚点：turnUuid 所属 turn 的最后一条主链消息（下一个 user
 * prompt 的前一条；末轮则为主链末梢）。用于「包含该 turn」的整段分支。
 */
export function turnEndUuid(
  source: string,
  turnUuid: string,
): string | undefined {
  const chain = mainChain(parseRecords(source));
  const index = chain.findIndex(
    (record) => record.uuid === turnUuid && isUserPromptRecord(record),
  );
  if (index < 0) return undefined;
  for (let i = index + 1; i < chain.length; i++)
    if (isUserPromptRecord(chain[i])) {
      const anchor = chain[i - 1];
      return anchor?.uuid ? String(anchor.uuid) : undefined;
    }
  const leaf = chain.at(-1);
  return leaf?.uuid ? String(leaf.uuid) : undefined;
}

/**
 * 生成分支会话的 JSONL 内容：把 sessionId 重写为新会话 id。
 * - 不传 anchorUuid：整份复制（文件级 fork，原会话原样保留）。
 * - 传 anchorUuid：只保留锚点行及之前按文件顺序写入的记录，外加无 uuid
 *   的元数据行（ai-title/custom-title 等；last-prompt 除外，它引用的
 *   叶节点可能已被裁掉）。被丢弃的旧分支记录留在原文件，不受影响。
 * 锚点不在文件里时返回 undefined。
 */
export function branchClaudeHistory(
  source: string,
  newSessionId: string,
  anchorUuid?: string,
): string | undefined {
  const lines = source.split(/\r?\n/).filter(Boolean);
  let cut = lines.length;
  if (anchorUuid !== undefined) {
    const at = lines.findIndex((line) => {
      try {
        return JSON.parse(line)?.uuid === anchorUuid;
      } catch {
        return false;
      }
    });
    if (at < 0) return undefined;
    cut = at + 1;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let record: ClaudeRecord;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (anchorUuid !== undefined) {
      if (record.type === "last-prompt") continue;
      if (i >= cut && record.uuid) continue;
    }
    if (typeof record.sessionId === "string") record.sessionId = newSessionId;
    out.push(JSON.stringify(record));
  }
  return `${out.join("\n")}\n`;
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
          const item = claudeToolItem(part, record);
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
    model: "default",
    ...(model !== "default" ? { resolvedModel: model } : {}),
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
