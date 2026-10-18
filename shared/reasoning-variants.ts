/**
 * 推理强度档位的展示顺序（强 → 弱）。OpenCode 的 variants 由用户手填，
 * 配置里的 key 顺序不可控，统一在这里排序；未知档位按字母序排在后面。
 */
const REASONING_VARIANT_RANK: Record<string, number> = {
  ultra: 0,
  max: 1,
  xhigh: 2,
  "x-high": 2,
  high: 3,
  medium: 4,
  low: 5,
  minimal: 6,
  none: 7,
};

const UNKNOWN_VARIANT_RANK = 8;

export function reasoningVariantRank(name: string): number {
  return (
    REASONING_VARIANT_RANK[name.trim().toLowerCase()] ?? UNKNOWN_VARIANT_RANK
  );
}

export function compareReasoningVariants(a: string, b: string): number {
  return reasoningVariantRank(a) - reasoningVariantRank(b) || a.localeCompare(b);
}

export function sortReasoningVariants<T extends string>(names: Iterable<T>): T[] {
  return [...names].sort(compareReasoningVariants);
}
