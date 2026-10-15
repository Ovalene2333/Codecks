import { rawApi } from "../api";
import { commandPresentation, toolCallPresentation } from "./turn-items";

/** 回合计时/TPS 与折叠展开的前端侧小工具：纯函数为主，可单测。 */

export interface TurnStats {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  outputTokens?: number;
  tps?: number;
}

export interface TurnProgress {
  turnId?: string;
  outputTokens?: number;
  elapsedMs?: number;
}

/** 47.6 token/s、167 token/s：百以上取整，以下留一位小数。 */
export function formatTps(tps: unknown) {
  const value = Number(tps);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} token/s`;
}

/** 进行中回合的实时估算：累计生成 token ÷ 已用秒。 */
export function progressTps(progress?: TurnProgress | null) {
  const output = Number(progress?.outputTokens);
  const elapsed = Number(progress?.elapsedMs);
  if (
    !Number.isFinite(output) ||
    output <= 0 ||
    !Number.isFinite(elapsed) ||
    elapsed <= 0
  )
    return "";
  return formatTps(output / (elapsed / 1000));
}

/** 口语化时长：< 1 分钟写 32.4 s，以上 4 分 12 秒、1 小时 3 分。 */
export function formatTurnDuration(ms: unknown) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 60_000) return `${(Math.round(value / 100) / 10).toFixed(1)} s`;
  const total = Math.round(value / 1000);
  const minutes = Math.floor(total / 60);
  if (minutes < 60)
    return total % 60 ? `${minutes} 分 ${total % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/**
 * 工具行用时：瞬时工具剔除（< 0.1 秒不影像），秒以下也留一位小数
 * （0.4 s），显示口径与回合用时一致。
 */
export function formatToolDuration(startedAt: unknown, endedAt: unknown) {
  const start = Number(startedAt);
  const end = Number(endedAt);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end)) return "";
  const ms = end - start;
  if (!(ms >= 100)) return "";
  return `用时 ${formatTurnDuration(ms)}`;
}

/** 每段统计行：用时 1.5 s 47.6 token/s（缺啥就不显示啥）。 */
export function statsLine(stats?: TurnStats | null) {
  if (!stats || typeof stats !== "object") return "";
  const parts: string[] = [];
  if (stats.durationMs != null) {
    const duration = formatTurnDuration(stats.durationMs);
    if (duration) parts.push(`用时 ${duration}`);
  }
  const tps = formatTps(stats.tps);
  if (tps) parts.push(tps);
  else if (Number(stats.outputTokens) > 0)
    parts.push(`生成 ${Number(stats.outputTokens)} tokens`);
  return parts.join(" ");
}

/** 3.8 万字、38 KB：折叠加载按钮上的体量提示。 */
export function formatFoldedSize(chars: unknown) {
  const value = Math.max(0, Math.floor(Number(chars) || 0));
  if (value <= 0) return "";
  if (value < 1024) return `${value} 字`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * 底部状态块的步骤文案（保留给需要的工具文案调用方用）：跟工具行同一套
 * presentation（读取/检索/编辑/调用……），动作词与目标命令分开。
 */
export function describeStepParts(
  step?: { item?: any },
  cwd?: string,
): { action: string; target: string } {
  const item = step?.item;
  if (!item || typeof item !== "object")
    return { action: "", target: "" };
  if (item.type === "reasoning") return { action: "思考过程", target: "" };
  if (item.type === "agentMessage")
    return { action: "正在回复", target: "" };
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const { tool, scope } = toolCallPresentation(item);
    const name = String(tool || "工具").trim() || "工具";
    const where = String(scope || "").trim();
    return { action: `正在调用 ${name}`, target: where };
  }
  const presentation = commandPresentation(item, cwd);
  const action = presentation.label
    ? `正在${presentation.label}`
    : "正在执行";
  const target = String(
    presentation.target || item.command || item.title || "",
  ).trim();
  return { action, target };
}

/**
 * 底部状态块的步骤文案：跟工具行同一套 presentation（读取/检索/编辑/
 * 调用……），读起来像时间线里自然的一行，而不是另一套语言。
 */
export function describeStep(step?: { item?: any }, cwd?: string) {
  const { action, target } = describeStepParts(step, cwd);
  if (!action) return "";
  return target ? `${action} ${target}` : action;
}

/**
 * 按 turnId 拉单个回合全文（折叠展开用）：恒为未折叠原文，
 * 与 readThread 的 ?full=1 等价但只传一个回合。
 */
export async function fetchTurnDetail(
  thread: { agentId?: string; id: string },
  turnId: string,
) {
  const agent = thread.agentId || "codex";
  const response = await rawApi(
    `/api/agents/${encodeURIComponent(agent)}/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(turnId)}`,
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

/**
 * 把已展开的回合叠加回会话全文：completed 回合内容不可变，
 * 后续重拉（折叠态）回来直接按 id 覆盖即可，不会丢更新。
 */
export function applyExpandedTurns(full: any, expanded: Map<string, any>) {
  if (!full || typeof full !== "object" || !Array.isArray(full.turns)) return full;
  if (!expanded || expanded.size === 0) return full;
  let changed = false;
  const turns = full.turns.map((turn: any) => {
    const id = String(turn?.id || "");
    const detail = id ? expanded.get(id) : undefined;
    if (!detail) return turn;
    changed = true;
    return detail;
  });
  return changed ? { ...full, turns } : full;
}
