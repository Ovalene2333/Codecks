import type { UsageTotals } from "./stats";

// 社区（sub2api/sap 类）换算口径：订阅用量按 OpenAI 官方 API 目录价折算
// 成美元，只作参考不代表真实账单。单位 USD / 1M tokens（标准短上下文档）。
// cachedInput 是命中缓存的输入价；stats 里 input 已是不含缓存的部分。
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const GPT56_SOL: ModelPrice = { input: 5, cachedInput: 0.5, output: 30 };
const GPT54: ModelPrice = { input: 2.5, cachedInput: 0.25, output: 15 };
// gpt-5.2/5.3-codex、spark、5.1-codex 等 sub2api 统一按 gpt-5.2-codex 档计。
const GPT52_CODEX: ModelPrice = { input: 1.75, cachedInput: 0.175, output: 14 };
const GPT6_ASTRA: ModelPrice = { input: 10, cachedInput: 1, output: 50 };

// 按前缀匹配，长的在前；命中不了（含 "default"）回落到当前主力档 gpt-5.6-sol。
// 费率对齐 sub2api（LiteLLM 官方目录价口径）：tier 名（sol/terra/luna/astra）
// 必须显式列出，否则会被裸代际前缀吃到旗舰价。
const PRICE_TABLE: [prefix: string, price: ModelPrice][] = [
  ["gpt-6-astra", GPT6_ASTRA],
  ["gpt-6-sol", { input: 2, cachedInput: 0.2, output: 10 }],
  ["gpt-6-luna", { input: 0.1, cachedInput: 0.01, output: 0.5 }],
  ["gpt-6", GPT6_ASTRA], // 裸 gpt-6 canonicalize 到 Astra
  ["gpt-5.6-cyber", { input: 12.5, cachedInput: 1.25, output: 75 }],
  ["gpt-5.6-terra", { input: 2, cachedInput: 0.2, output: 12 }],
  ["gpt-5.6-luna", { input: 0.2, cachedInput: 0.02, output: 1.2 }],
  ["gpt-5.6", GPT56_SOL], // Sol 及 gpt-5.6-codex/-max/-high 等同档
  ["gpt-5.5-cyber", { input: 12.5, cachedInput: 1.25, output: 75 }],
  ["gpt-5.5-pro", { input: 30, cachedInput: 30, output: 180 }],
  ["gpt-5.5", { input: 5, cachedInput: 0.5, output: 30 }],
  ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.5 }],
  ["gpt-5.4-nano", { input: 0.2, cachedInput: 0.02, output: 1.25 }],
  ["gpt-5.4", GPT54],
  ["gpt-5.3", GPT52_CODEX], // 含 gpt-5.3-codex(-spark/-xhigh 等)
  ["gpt-5.2", GPT52_CODEX],
  ["gpt-5.1-codex", GPT52_CODEX], // sub2api: 5.1-codex 计为 5.3-codex
  ["gpt-5-mini", { input: 0.25, cachedInput: 0.025, output: 2 }],
  ["gpt-5-nano", { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ["gpt-5", GPT54], // sub2api codex 别名：gpt-5/5.1 → gpt-5.4 档
  ["codex-mini", { input: 1.5, cachedInput: 0.375, output: 6 }],
  ["claude-opus-5-5", { input: 4, cachedInput: 0.2, output: 20 }],
  ["claude-opus-5", { input: 5, cachedInput: 0.5, output: 25 }], // 与 opus-4-8 同档
  ["claude-sonnet-5-5", { input: 2, cachedInput: 0.2, output: 10 }],
  ["claude-haiku", { input: 1, cachedInput: 0.1, output: 5 }],
  ["claude-opus", { input: 4, cachedInput: 0.2, output: 20 }],
  ["claude-sonnet", { input: 2, cachedInput: 0.2, output: 10 }],
  ["opus", { input: 4, cachedInput: 0.2, output: 20 }], // "opus[1m]" 这类裸拼写
  ["sonnet", { input: 2, cachedInput: 0.2, output: 10 }],
  ["gpt-4.1-mini", { input: 0.4, cachedInput: 0.1, output: 1.6 }],
  ["gpt-4.1-nano", { input: 0.1, cachedInput: 0.025, output: 0.4 }],
  ["gpt-4.1", { input: 2, cachedInput: 0.5, output: 8 }],
  ["gpt-4o-mini", { input: 0.15, cachedInput: 0.075, output: 0.6 }],
  ["gpt-4o", { input: 2.5, cachedInput: 1.25, output: 10 }],
  ["o4-mini", { input: 1.1, cachedInput: 0.275, output: 4.4 }],
  ["o3-mini", { input: 1.1, cachedInput: 0.55, output: 4.4 }],
  ["o3", { input: 2, cachedInput: 0.5, output: 8 }],
];

export function modelPrice(model?: string): ModelPrice {
  // 去掉 "openai/" 这类供应商前缀与 ":thinking" 之类的后缀再匹配。
  const name = (model || "")
    .toLowerCase()
    .replace(/^.*\//, "")
    .split(":")[0]
    .trim()
    .replace(/^gpt(\d)/, "gpt-$1");
  for (const [prefix, price] of PRICE_TABLE) {
    if (name.startsWith(prefix)) return price;
  }
  return GPT56_SOL;
}

export function estimateCost(totals: UsageTotals, model?: string): number {
  const price = modelPrice(model);
  return (
    (totals.input * price.input +
      totals.cachedInput * price.cachedInput +
      totals.output * price.output) /
    1_000_000
  );
}

// ChatGPT 订阅档位月价（USD/月，社区口径）。企业/教育版无公开固定价，返回
// null 不显示。
const PLAN_PRICES: [keyword: string, usdPerMonth: number][] = [
  ["pro", 200],
  ["plus", 20],
  ["business", 30],
  ["team", 30],
  ["go", 8],
];

export function planPrice(planType?: string | null): number | null {
  const name = (planType || "").toLowerCase();
  if (!name || name.includes("free") || name.includes("enterprise"))
    return name.includes("free") ? 0 : null;
  for (const [keyword, price] of PLAN_PRICES) {
    if (name.includes(keyword)) return price;
  }
  return null;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}
