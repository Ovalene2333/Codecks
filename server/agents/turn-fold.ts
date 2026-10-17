/**
 * 已完成回合的工具输出折叠：readThread 默认只传摘要，详情走
 * `GET /api/agents/:agentId/threads/:threadId/turns/:turnId` 按需拉取。
 *
 * 操作的是各 adapter 已归一化的 Codex 形状 items，与 agent 无关，
 * 所以折叠逻辑全 Agency 通用（codex/claude/opencode/ACP）。
 * 只动传输层：adapter 内存/落盘数据不动，详情接口直接读原文。
 *
 * 阈值式折叠：小输出（阈值内）原样透传，会话阅读体验零变化；
 * 只有大输出才被折叠，省的是真正占带宽/内存的部分。
 */

/** 超过该字符数的工具输出/diff 才折叠。 */
export const FOLD_OUTPUT_CHARS = 2_048;
/** 折叠时保留的开头预览字符数，供用户判断是否值得展开。 */
export const FOLDED_PREVIEW_CHARS = 240;
/**
 * 折叠后仍保留的小输入上限：summary 的 target/pattern 依赖 input
 *（shell 真实命令、grep pattern），小输入直接保留，大 JSON 才懒加载。
 */
export const FOLDED_INPUT_CHARS = 1_024;

function textLength(value: unknown) {
  return typeof value === "string" ? value.length : 0;
}

function jsonLength(value: unknown) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function foldCommandItem(item: any, output: string) {
  const folded: any = {
    ...item,
    folded: true,
    outputChars: output.length,
    outputPreview: output.slice(0, FOLDED_PREVIEW_CHARS),
  };
  delete folded.aggregatedOutput;
  // metadata（todos 已在构造时提出为 item.todos）整体懒加载。
  delete folded.metadata;
  if (jsonLength(folded.input) > FOLDED_INPUT_CHARS) delete folded.input;
  return folded;
}

function foldFileItem(item: any, chars: number) {
  const changes = Array.isArray(item.changes)
    ? item.changes.map((change: any) => {
        if (!change || typeof change !== "object") return change;
        const { diff, ...rest } = change;
        void diff;
        return rest;
      })
    : item.changes;
  return { ...item, changes, folded: true, outputChars: chars };
}

function foldToolCallItem(item: any, chars: number) {
  // 展示行只需要 tool/scope/status；输入输出 JSON 整体懒加载。
  const folded: any = {
    id: item.id,
    type: item.type,
    folded: true,
    outputChars: chars,
  };
  for (const key of ["tool", "server", "namespace", "status", "error"]) {
    if (item[key] !== undefined) folded[key] = item[key];
  }
  return folded;
}

/** 单个 item 的折叠：不够大/非工具类/已折叠都原样返回。 */
export function foldItem(item: any) {
  if (!item || typeof item !== "object" || item.folded) return item;
  if (item.type === "commandExecution" || item.type === "subagent") {
    const output =
      typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    if (output.length < FOLD_OUTPUT_CHARS) return item;
    return foldCommandItem(item, output);
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    let chars = 0;
    for (const change of item.changes) {
      if (change && typeof change === "object")
        chars += textLength(change.diff);
    }
    if (chars < FOLD_OUTPUT_CHARS) return item;
    return foldFileItem(item, chars);
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const chars =
      textLength(
        typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? ""),
      ) +
      textLength(
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? item.result ?? ""),
      );
    if (chars < FOLD_OUTPUT_CHARS) return item;
    return foldToolCallItem(item, chars);
  }
  return item;
}

/**
 * 折叠一批 turns：活跃回合（activeTurnId 或 inProgress）永远全文，
 * 其余回合的工具输出按阈值折叠。不 mutate 输入（ACP 等 adapter
 * 返回的是内存对象），只对折叠项做浅拷贝。
 */
export function foldTurns(turns: any[], activeTurnId?: string) {
  if (!Array.isArray(turns)) return turns;
  const active = String(activeTurnId || "");
  return turns.map((turn) => {
    if (!turn || typeof turn !== "object") return turn;
    if (turn.status === "inProgress") return turn;
    if (active && String(turn.id || "") === active) return turn;
    if (!Array.isArray(turn.items)) return turn;
    let changed = false;
    const items = turn.items.map((item: any) => {
      const folded = foldItem(item);
      if (folded !== item) changed = true;
      return folded;
    });
    return changed ? { ...turn, items } : turn;
  });
}

/**
 * 与前端 `src/cache.ts` 的 PARTIAL_KEY 同名同义：下发 turns 切片时，
 * 被截掉的老轮数记在这个键上。前端据此判定“非全文”（304 不复用、
 * 展示“加载更早”按钮）。改名必须两边一起改。
 */
export const TURN_SLICE_PARTIAL_KEY = "__cachedTailOmitted";

/**
 * turns 分页切片：只下发最新的 limit 轮（beforeTurnId 之前再往前数）。
 * 返回 { turns, totalTurns, hasMore } 并在 omitted>0 时打上 PARTIAL_KEY。
 * 不 mutate 输入。
 */
export function sliceTurnsPage(
  turns: any[],
  limit: number,
  beforeTurnId?: string,
): { turns: any[]; totalTurns: number; hasMore: boolean; omitted: number } {
  const list = Array.isArray(turns) ? turns : [];
  const totalTurns = list.length;
  let end = list.length;
  const before = String(beforeTurnId || "").trim();
  if (before) {
    const index = list.findIndex((turn) => String(turn?.id || "") === before);
    // beforeTurn 找不到（被 revert/压缩掉）：退化为取最新，当全文用。
    if (index >= 0) end = index;
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : totalTurns;
  const start = Math.max(0, end - safeLimit);
  return {
    turns: list.slice(start, end),
    totalTurns,
    hasMore: start > 0,
    omitted: start,
  };
}
