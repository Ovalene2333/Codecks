import assert from "node:assert/strict";
import test from "node:test";
import { buildLaneScenarios, sanitizeLaneText } from "./deck-api-lanes.js";

const threads = [
  { agentId: "opencode", id: "src-thread", name: "主研究会话", alias: "s-main", cwd: "/srv/acme/traceroute" },
  { agentId: "codex", id: "worker-thread", name: "实现任务", alias: "s-worker", cwd: "/srv/acme/traceroute" },
];

const ask: any = {
  id: "ask-1",
  alias: "7f3a2c90",
  sourceAgentId: "opencode",
  sourceThreadId: "src-thread",
  targetAgentId: "codex",
  targetThreadId: "worker-thread",
  targetAlias: "s-worker",
  question: "请实现模块，运行目录 /srv/acme/runs/r1，参考 https://example.test/a?token=secret",
  returnMode: "queue",
  status: "answered",
  createdAt: 1000,
  updatedAt: 20_000,
  deliveryId: "ask:ask-1",
  executionCompletion: { turnId: "t1", status: "completed" },
  sentMessages: [
    { id: "m1", text: "M1 完成，GPU NOT RUN；路径 /srv/acme/runs/r1", mode: "queue", deliveryId: "d1" },
    { id: "m2", text: "M2 已稳定：连续 2 条落盘", mode: "queue", deliveryId: "d2" },
  ],
};

const delivery = (values: any) => ({
  agentId: "codex",
  threadId: "worker-thread",
  mode: "queue",
  status: "delivered",
  createdAt: 2_000,
  updatedAt: 2_000,
  ...values,
});

const deliveries: any[] = [
  delivery({ id: "ask:ask-1", text: ask.question, createdAt: 1_000 }),
  delivery({ id: "send:follow-1", mode: "feedback", text: "[send:follow-1] 先改评估器", createdAt: 3_000 }),
  delivery({
    id: "wake:watcher-1",
    text: "[wake:abc123] 任务结束 exit=0",
    createdAt: 4_000,
  }),
  delivery({
    id: "wake:watcher-1b",
    text: "[wake:abc123] 任务结束 exit=0（重复通知）",
    createdAt: 5_000,
  }),
  // 目标回传到来源，必须能从台账里识别为回复而不是来源补充。
  {
    ...delivery({ id: "wake:d1", text: ask.sentMessages[0].text, createdAt: 10_000 }),
    agentId: "opencode",
    threadId: "src-thread",
  },
  {
    ...delivery({ id: "wake:d2", text: ask.sentMessages[1].text, createdAt: 11_000 }),
    agentId: "opencode",
    threadId: "src-thread",
  },
];

test("泳道从台账和投递记录还原真实顺序", () => {
  const result = buildLaneScenarios([ask], deliveries, threads, { limit: 1, maxSteps: 20 });
  const scenario = result.scenarios[0];
  assert.equal(scenario.id, "7f3a2c90");
  assert.deepEqual(scenario.lanes.map((lane) => lane.id), ["user", "source", "deck", "target"]);
  assert.equal(scenario.steps[0].from, "user");
  assert.equal(scenario.steps[0].to, "source");
  const question = scenario.steps.find((step) => step.title === "发起询问");
  assert.equal(question?.from, "source");
  assert.equal(question?.to, "target");
  assert.ok(scenario.steps.some((step) => step.kind === "send" && step.title === "来源补充"));
  const wake = scenario.steps.find((step) => step.kind === "wake");
  assert.equal(wake?.title, "唤醒通知 ×2");
  assert.equal(wake?.from, "deck");
  assert.equal(wake?.to, "target");
  const replies = scenario.steps.filter((step) => step.id.startsWith("reply:"));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].from, "target");
  assert.equal(replies[0].to, "source");
  assert.equal(replies.at(-1)?.kind, "success");
  assert.equal(scenario.meta.replies, 2);
  assert.equal(scenario.meta.followUps, 3);
});

test("脱敏只作用于导出快照，路径、URL、密钥不外泄", () => {
  const text = sanitizeLaneText(
    "写入 /srv/acme/runs/r1 和 C:\\Users\\demo\\x，访问 https://example.test/a 或 10.0.0.8，Bearer abcdef",
  );
  assert.match(text, /<path>/);
  assert.match(text, /<url>/);
  assert.match(text, /<ip>/);
  assert.doesNotMatch(text, /\/srv\/acme/);
  assert.doesNotMatch(text, /example\.test/);
  assert.doesNotMatch(text, /10\.0\.0\.8/);
  const result = buildLaneScenarios([ask], deliveries, threads, { limit: 1, sanitize: true });
  const exported = JSON.stringify(result);
  assert.doesNotMatch(exported, /\/srv\/acme/);
  assert.doesNotMatch(exported, /example\.test/);
  assert.equal(result.scenarios[0].meta.askId.length, 5);
});

test("投递失败与 detached 会改变泳道标记", () => {
  const failed = {
    ...ask,
    id: "ask-2",
    alias: "abcdef12",
    status: "completed",
    sentMessages: [],
    detached: true,
  };
  const result = buildLaneScenarios(
    [failed],
    [
      delivery({ id: "ask:ask-2", text: failed.question, createdAt: 1_000 }),
      delivery({
        id: "send:fail-1",
        mode: "feedback",
        status: "failed",
        error: "回合已变化",
        text: "[send:fail-1] 只改评估器",
        createdAt: 2_000,
      }),
    ],
    threads,
    { limit: 1 },
  );
  const scenario = result.scenarios[0];
  assert.ok(scenario.steps.some((step) => step.kind === "failure" && step.title === "来源投递失败"));
  assert.equal(scenario.steps.at(-1)?.kind, "query");
  assert.match(scenario.rules.join("\n"), /202 只代表受理/);
});

test("可以按询问别名、会话别名或 threadId 定位", () => {
  for (const query of ["7f3a2c90", "@s-worker", "worker-thread", "codex:worker-thread", "src-thread"]) {
    const result = buildLaneScenarios([ask], deliveries, threads, { query });
    assert.equal(result.scenarios.length, 1, query);
  }
  assert.equal(buildLaneScenarios([ask], deliveries, threads, { session: "@s-main" }).scenarios.length, 1);
  assert.equal(buildLaneScenarios([ask], deliveries, threads, { ask: "ask-1" }).scenarios.length, 1);
  assert.equal(buildLaneScenarios([ask], deliveries, threads, { query: "missing" }).scenarios.length, 0);
});

test("来源会话的真实用户消息进入用户泳道", () => {
  const result = buildLaneScenarios([ask], deliveries, threads, {
    limit: 1,
    userMessages: [
      { agentId: "opencode", threadId: "src-thread", atMs: 800, text: "请实现模块，先跑测试" },
      { agentId: "opencode", threadId: "src-thread", atMs: 12_000, text: "补充：不要动 GPU" },
      { agentId: "opencode", threadId: "other-thread", atMs: 900, text: "不该出现" },
    ],
  });
  const scenario = result.scenarios[0];
  assert.equal(scenario.lanes[0].id, "user");
  const users = scenario.steps.filter((step) => step.from === "user");
  assert.equal(users.length, 2);
  assert.match(users[0].detail, /请实现模块/);
  assert.match(users[1].detail, /不要动 GPU/);
  assert.ok(!scenario.steps.some((step) => step.detail.includes("不该出现")));
});

test("没有用户消息时用会话标题兜底，仍保留四列", () => {
  const result = buildLaneScenarios([ask], deliveries, threads, { limit: 1 });
  const scenario = result.scenarios[0];
  assert.deepEqual(scenario.lanes.map((lane) => lane.id), ["user", "source", "deck", "target"]);
  const user = scenario.steps.find((step) => step.from === "user");
  assert.equal(user?.tag, "会话标题");
  assert.match(user?.detail || "", /主研究会话/);
});
