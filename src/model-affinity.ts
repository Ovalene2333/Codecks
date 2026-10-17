import { api, put } from "./api";
import type { SearchableOption } from "./SearchablePicker";

export interface ModelAffinityData {
  /** 收藏的模型 id（model 字段），保持用户收藏顺序。 */
  starred: string[];
  /** 每个模型的累计选中次数。 */
  counts: Record<string, number>;
  /** 最近一次选中的模型 id。 */
  last: string | null;
  updatedAt: number;
}

export interface AffinityListParams {
  providerId?: string;
  directory?: string;
}

/** 模型选择器的「命中组」：和提供商原分组互斥命名，固定排最前。 */
export const STARRED_MODEL_GROUP = "已收藏";
export const RECENT_MODEL_GROUP = "上次选择";
export const FREQUENT_MODEL_GROUP = "常用模型";
export const MAX_FREQUENT_MODELS = 3;

function cleanAffinity(data: unknown): ModelAffinityData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Partial<ModelAffinityData>;
  if (!Array.isArray(record.starred)) return null;
  if (!record.counts || typeof record.counts !== "object") return null;
  return {
    starred: record.starred.filter((item) => typeof item === "string"),
    counts:
      Array.isArray(record.counts) || record.counts === null
        ? {}
        : (record.counts as Record<string, number>),
    last: typeof record.last === "string" ? record.last : null,
    updatedAt: 0,
  };
}

export function affinityListParams(
  agentId: string,
  providerId?: string,
  cwd?: string,
): AffinityListParams {
  // 和模型目录请求键同粒度：opencode 按目录，其他 agent 按供应商。
  if (agentId === "opencode") {
    const directory = cwd?.trim();
    return directory ? { directory } : {};
  }
  const id = providerId?.trim();
  return id ? { providerId: id } : {};
}

export async function loadModelAffinity(
  agentId: string,
  params: AffinityListParams,
): Promise<ModelAffinityData | null> {
  try {
    const query = new URLSearchParams({
      ...(params.providerId ? { providerId: params.providerId } : {}),
      ...(params.directory ? { directory: params.directory } : {}),
    });
    const data = await api<ModelAffinityData>(
      `/agents/${agentId}/model-affinity${query.size ? `?${query}` : ""}`,
    );
    return cleanAffinity(data);
  } catch {
    return null;
  }
}

export async function saveModelAffinity(
  agentId: string,
  params: AffinityListParams,
  patch: { used?: string; star?: { model: string; on: boolean } },
): Promise<ModelAffinityData | null> {
  try {
    const data = await put<ModelAffinityData>(
      `/agents/${agentId}/model-affinity`,
      {
        ...params,
        ...(patch.used ? { used: patch.used } : {}),
        ...(patch.star ? { star: patch.star } : {}),
      },
    );
    return cleanAffinity(data);
  } catch {
    return null;
  }
}

/**
 * 把「已收藏 / 上次选择 / 常用」的命中提升到组前：
 * - 命中项从原供应商分组里挪出来，避免同一模型出现两次（重复 value
 *   会在虚拟列表里生成重复 key）。
 * - 当前已选模型不挪动（它已经展示在触发器里了）。
 * - 收藏保持用户收藏顺序；上次选择单行；常用按次数取前三。
 */
export function composeModelOptions(
  base: SearchableOption[],
  affinity: ModelAffinityData | null,
  selected: string,
): SearchableOption[] {
  if (!affinity) return base;
  const data: ModelAffinityData = {
    starred: affinity.starred || [],
    counts: affinity.counts || {},
    last: affinity.last ?? null,
    updatedAt: 0,
  };
  const byValue = new Map<string, SearchableOption>();
  for (const option of base) {
    if (!byValue.has(option.value)) byValue.set(option.value, option);
  }
  const moved = new Set<string>();
  const composed: SearchableOption[] = [];
  const starred = data.starred.filter(
    (value) => byValue.has(value) && value !== selected,
  );
  for (const value of starred) {
    const option = byValue.get(value);
    if (!option) continue;
    composed.push({ ...option, group: STARRED_MODEL_GROUP, starred: true });
    moved.add(value);
  }
  // 目录抖动（opencode 按目录现查，超时/供应商集合变化）时收藏可能暂时不
  // 在目录里：保留占位行（短 ID 做展示名、全 ID 放 hint），否则“已收藏”
  // 分组会凭空消失，看起来像收藏掉了。选中仍按 ID 透传，后端照常处理。
  for (const value of data.starred) {
    if (byValue.has(value) || moved.has(value) || value === selected) continue;
    composed.push({
      value,
      label: value.split("/").filter(Boolean).pop() || value,
      hint: value,
      group: STARRED_MODEL_GROUP,
      starred: true,
    });
    moved.add(value);
  }
  const last =
    data.last && data.last !== selected && byValue.has(data.last) ? data.last : null;
  if (last && !moved.has(last)) {
    const option = byValue.get(last);
    if (option) {
      composed.push({ ...option, group: RECENT_MODEL_GROUP });
      moved.add(last);
    }
  }
  // 上次选择同理：目录里暂时没有也保留占位行。
  if (
    data.last &&
    data.last !== selected &&
    !byValue.has(data.last) &&
    !moved.has(data.last)
  ) {
    composed.push({
      value: data.last,
      label: data.last.split("/").filter(Boolean).pop() || data.last,
      hint: data.last,
      group: RECENT_MODEL_GROUP,
    });
    moved.add(data.last);
  }
  const ranked = Object.entries(data.counts)
    .filter(
      ([value, count]) =>
        typeof count === "number" &&
        count > 0 &&
        value !== selected &&
        !moved.has(value) &&
        byValue.has(value),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_MODELS);
  for (const [value] of ranked) {
    const option = byValue.get(value);
    if (!option) continue;
    composed.push({ ...option, group: FREQUENT_MODEL_GROUP });
    moved.add(value);
  }
  for (const option of base) {
    if (moved.has(option.value)) continue;
    // 当前已选模型留在行内：已收藏时也点亮行尾星标。
    composed.push(
      option.value === selected && data.starred.includes(option.value)
        ? { ...option, starred: true }
        : option,
    );
  }
  // 当前已选模型暂时不在目录里时补一行无分组占位（无分组天然不过
  // “仅已连接”过滤），保证勾选行可见、星标可点。
  if (selected && !byValue.has(selected)) {
    composed.push({
      value: selected,
      label: selected.split("/").filter(Boolean).pop() || selected,
      hint: selected,
      ...(data.starred.includes(selected) ? { starred: true } : {}),
    });
  }
  return composed;
}
