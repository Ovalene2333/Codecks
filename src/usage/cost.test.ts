import test from "node:test";
import assert from "node:assert/strict";
import { estimateCost, formatCost, modelPrice, planPrice } from "./cost.ts";

const totals = (input: number, cachedInput: number, output: number) => ({
  total: input + cachedInput + output,
  input,
  cachedInput,
  output,
  reasoningOutput: 0,
});

test("current generation prices match community API list rates", () => {
  // gpt-5.6-sol: 1M uncached input + 1M cached + 1M output = 4 + 0.4 + 20
  const cost = estimateCost(totals(1_000_000, 1_000_000, 1_000_000), "gpt-5.6-sol");
  assert.equal(cost, 24.4);
  assert.equal(estimateCost(totals(1_000_000, 0, 0), "gpt-6-astra"), 10);
  assert.equal(estimateCost(totals(1_000_000, 0, 0), "gpt-5.6-luna"), 0.2);
  assert.equal(estimateCost(totals(0, 0, 1_000_000), "gpt-5.5"), 30);
});

test("provider prefixes and unknown models fall back to gpt-5.6-sol rates", () => {
  assert.equal(modelPrice("openai/gpt-5.6-terra").input, 2);
  assert.equal(modelPrice("default"), modelPrice("gpt-5.6"));
  assert.equal(modelPrice(undefined), modelPrice("gpt-5.6-sol"));
});

test("planPrice maps subscription tiers to monthly USD", () => {
  assert.equal(planPrice("pro"), 200);
  assert.equal(planPrice("ChatGPT Plus"), 20);
  assert.equal(planPrice("business"), 30);
  assert.equal(planPrice("free"), 0);
  assert.equal(planPrice("enterprise"), null);
  assert.equal(planPrice(undefined), null);
});

test("formatCost keeps small amounts readable", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(3.14159), "$3.14");
  assert.equal(formatCost(1234.5), "$1235");
});
