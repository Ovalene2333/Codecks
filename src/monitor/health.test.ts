import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesFor } from "../agents.ts";
import type { AgentDescriptor } from "../types.ts";
import { agentHealth, healthIssueCount } from "./health.ts";

const agent = (extra: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  id: "kimi",
  name: "Kimi",
  available: true,
  online: false,
  capabilities: capabilitiesFor(undefined, { agentId: "kimi" }),
  ...extra,
});

test("a startup failure is an error, but a disabled agent is just off", () => {
  const failed = agent({ error: "spawn kimi ENOENT" });
  assert.deepEqual(
    [agentHealth(failed).tone, agentHealth(failed).label],
    ["error", "启动失败"],
  );

  // 同样的报错残留在描述符里，停用后也不能再算故障。
  const disabled = agent({
    enabled: false,
    disabledReason: "default",
    defaultNote: "未检测到 kimi 命令",
    error: "spawn kimi ENOENT",
  });
  assert.deepEqual(agentHealth(disabled), {
    tone: "off",
    label: "未启用",
    note: "未检测到 kimi 命令",
  });
});

test("the disabled note tells who turned the agent off", () => {
  assert.equal(
    agentHealth(agent({ enabled: false, disabledReason: "user" })).note,
    "已在设置中停用",
  );
  assert.equal(
    agentHealth(agent({ enabled: false, disabledReason: "default" })).note,
    "默认不加载",
  );
});

test("disabled agents are not counted as health issues", () => {
  const agents = [
    agent({ id: "codex", name: "Codex", online: true }),
    agent({ id: "kimi", error: "spawn kimi ENOENT" }),
    agent({ id: "goose", enabled: false, error: "spawn goose ENOENT" }),
    agent({ id: "droid", enabled: false, disabledReason: "user" }),
  ];
  assert.equal(healthIssueCount(agents, []), 1);
});
