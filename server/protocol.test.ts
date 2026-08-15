import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyApprovalMethod,
  isChatgptAccount,
  parseAccount,
  parseRateLimits,
  parseSandboxMode,
  parseTimestamp,
  parseTokenUsage,
  sandboxPolicyFromMode,
  timestampFromId,
} from "./protocol.js";

test("rate-limit fixtures parse primary, secondary, and byLimitId", () => {
  const parsed = parseRateLimits({
    rateLimits: {
      primary: { used_percent: 31.4, resets_in_seconds: 18_000 },
      secondary: { usedPercent: 12, reset_after_seconds: 86_400 },
      byLimitId: {
        extra_fast: { used_percent: 88, reached: false },
      },
      plan_name: "Plus",
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.primary?.usedPercent, 31.4);
  assert.equal(parsed?.primary?.resetAfterSeconds, 18_000);
  assert.equal(parsed?.secondary?.usedPercent, 12);
  assert.equal(parsed?.byLimitId?.extra_fast.usedPercent, 88);
  assert.equal(parsed?.planName, "Plus");
});

test("array credits also land in byLimitId", () => {
  const parsed = parseRateLimits({
    credits: [{ limit_id: "bonus", used_percent: 5 }],
  });
  assert.equal(parsed?.byLimitId?.bonus.usedPercent, 5);
});

test("non-chatgpt account is not treated as a 0% bucket", () => {
  const account = parseAccount({
    account: { auth_mode: "apikey", plan_type: "api" },
  });
  assert.equal(isChatgptAccount(account), false);
  assert.equal(parseRateLimits(null), null);
});

test("account/read type=chatgpt is Official ChatGPT, not missing auth", () => {
  const account = parseAccount({
    account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
    requiresOpenaiAuth: true,
  });
  assert.equal(account?.chatgpt, true);
  assert.equal(account?.authMode, "chatgpt");
  assert.equal(account?.email, "user@example.com");
  assert.equal(account?.planType, "pro");
  assert.equal(isChatgptAccount(account), true);
});

test("personal access token is treated as ChatGPT-backed Official auth", () => {
  const account = parseAccount({
    account: { type: "personalAccessToken", email: "pat@example.com" },
  });
  assert.equal(isChatgptAccount(account), true);
});

test("official rateLimits/read fixture keeps primary percent", () => {
  const parsed = parseRateLimits({
    rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
      secondary: null,
      rateLimitReachedType: null,
    },
    rateLimitResetCredits: { availableCount: 2 },
    individualLimit: { usedPercent: 10, limit: 100 },
  });
  assert.equal(parsed?.primary?.usedPercent, 25);
  assert.equal(parsed?.primary?.windowDurationMins, 15);
  assert.equal(parsed?.resetCredits, 2);
  assert.equal(parsed?.monthly?.usedPercent, 10);
});

test("token usage extracts common keys without inventing totals", () => {
  const usage = parseTokenUsage({
    tokenUsage: { used_tokens: 12_000, context_window: 272_000 },
  });
  assert.deepEqual(usage, {
    used: 12_000,
    limit: 272_000,
  });
  assert.equal(parseTokenUsage({}), undefined);
});

test("token usage reads cumulative app-server totals and context window", () => {
  const usage = parseTokenUsage({
    tokenUsage: {
      total: {
        inputTokens: 18_000,
        cachedInputTokens: 7_500,
        outputTokens: 2_000,
        reasoningOutputTokens: 600,
        totalTokens: 20_000,
      },
      last: { totalTokens: 800 },
      modelContextWindow: 272_000,
    },
  });
  assert.deepEqual(usage, {
    total: 20_000,
    used: 800,
    limit: 272_000,
    input: 18_000,
    cachedInput: 7_500,
    output: 2_000,
    reasoningOutput: 600,
  });
});

test("timestampFromId reads UUIDv7 milliseconds", () => {
  const id = "019ffddc-408f-7e00-b7a1-5444c1acadf8";
  const ms = timestampFromId(id);
  assert.equal(ms, Number.parseInt("019ffddc408f", 16));
  assert.ok(ms && ms > Date.parse("2026-08-14T01:00:00Z"));
  assert.equal(timestampFromId("not-a-uuid"), undefined);
});

test("parseTimestamp accepts iso, unix seconds, and milliseconds", () => {
  assert.equal(parseTimestamp("2024-01-02T03:04:05.000Z"), Date.parse("2024-01-02T03:04:05.000Z"));
  assert.equal(parseTimestamp(1_704_164_645), 1_704_164_645_000);
  assert.equal(parseTimestamp(1_704_164_645_000), 1_704_164_645_000);
  assert.equal(parseTimestamp("", undefined, "1704164645"), 1_704_164_645_000);
  assert.equal(parseTimestamp({}), undefined);
});

test("approval methods classify without collapsing unknown kinds", () => {
  assert.equal(
    classifyApprovalMethod("item/fileChange/requestApproval"),
    "file",
  );
  assert.equal(
    classifyApprovalMethod("item/commandExecution/requestApproval"),
    "command",
  );
  assert.equal(
    classifyApprovalMethod("item/permissions/requestApproval"),
    "permission",
  );
  assert.equal(classifyApprovalMethod("item/requestUserInput"), "question");
  assert.equal(classifyApprovalMethod("item/foo/bar"), "unknown");
});

test("sandbox policy objects and permission profiles map to kebab-case modes", () => {
  assert.equal(parseSandboxMode("workspace-write"), "workspace-write");
  assert.equal(parseSandboxMode({ type: "workspaceWrite" }), "workspace-write");
  assert.equal(parseSandboxMode({ type: "readOnly" }), "read-only");
  assert.equal(
    parseSandboxMode({ type: "dangerFullAccess" }),
    "danger-full-access",
  );
  assert.equal(parseSandboxMode({ id: ":workspace" }), "workspace-write");
  assert.equal(parseSandboxMode({ id: ":read-only" }), "read-only");
  assert.deepEqual(sandboxPolicyFromMode("workspace-write"), {
    type: "workspaceWrite",
  });
  assert.deepEqual(sandboxPolicyFromMode("read-only"), { type: "readOnly" });
  assert.deepEqual(sandboxPolicyFromMode("danger-full-access"), {
    type: "dangerFullAccess",
  });
});
