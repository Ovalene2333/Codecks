import type { UsageTotals } from "./stats";

// 社区（sub2api/sap 类）换算口径：订阅用量按 OpenAI 官方 API 目录价折算
// 成美元，只作参考不代表真实账单。单位 USD / 1M tokens（标准短上下文档）。
// cachedInput 是命中缓存的输入价；stats 里 input 已是不含缓存的部分。
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const GPT56_SOL: ModelPrice = { input: 4, cachedInput: 0.4, output: 20 };

// 按前缀匹配，长的在前；命中不了（含 "default"）回落到当前主力档 gpt-5.6-sol。
const PRICE_TABLE: [prefix: string, price: ModelPrice][] = [
  ["gpt-6", { input: 10, cachedInput: 1, output: 50 }], // GPT-6 Astra
  ["gpt-5.6-cyber", { input: 12.5, cachedInput: 1.25, output: 75 }],
  ["gpt-5.6-terra", { input: 2, cachedInput: 0.2, output: 12 }],
  ["gpt-5.6-luna", { input: 0.2, cachedInput: 0.02, output: 1.2 }],
  ["gpt-5.6", GPT56_SOL], // Sol 及 gpt-5.6-codex 等同档
  ["gpt-5.5-cyber", { input: 12.5, cachedInput: 1.25, output: 75 }],
  ["gpt-5.5-pro", { input: 30, cachedInput: 30, output: 180 }],
  ["gpt-5.5", { input: 5, cachedInput: 0.5, output: 30 }],
  ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.5 }],
  ["gpt-5.4", { input: 2.5, cachedInput: 0.25, output: 15 }],
  ["gpt-5.3", { input: 1.75, cachedInput: 0.175, output: 14 }], // 含 gpt-5.3-codex
  ["gpt-5.2", { input: 1.75, cachedInput: 0.175, output: 14 }],
  ["gpt-5.1", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5-mini", { input: 0.25, cachedInput: 0.025, output: 2 }],
  ["gpt-5-nano", { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["codex-mini", { input: 1.5, cachedInput: 0.375, output: 6 }],
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
    .trim();
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
