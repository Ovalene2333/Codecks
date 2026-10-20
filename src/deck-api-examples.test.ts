import assert from "node:assert/strict";
import test from "node:test";
import data from "../shared/deck-api-swimlane-example.json";

const KINDS = new Set([
  "message",
  "send",
  "queue",
  "run",
  "success",
  "failure",
  "wake",
  "query",
]);

test("deck-api 泳道快照来自实际询问记录", () => {
  assert.equal(data.version, 1);
  assert.ok(data.scenarios.length >= 1);
  assert.match(data.source, /询问台账|消息投递/);
  const scenarioIds = new Set<string>();
  for (const scenario of data.scenarios) {
    assert.ok(scenario.id && !scenarioIds.has(scenario.id), scenario.id);
    scenarioIds.add(scenario.id);
    assert.ok(scenario.title && scenario.summary && scenario.rules.length);
    assert.ok(scenario.meta?.askId && scenario.meta.status);
    const lanes = new Set(scenario.lanes.map((lane) => lane.id));
    assert.equal(lanes.size, scenario.lanes.length, `${scenario.id} 泳道重复`);
    assert.equal(scenario.lanes[0].id, "user", "四列从用户开始");
    const steps = new Set<string>();
    for (const step of scenario.steps) {
      assert.ok(!steps.has(step.id), `${scenario.id}/${step.id} 步骤重复`);
      steps.add(step.id);
      assert.ok(lanes.has(step.from), `${scenario.id}/${step.id} from 不存在`);
      assert.ok(lanes.has(step.to), `${scenario.id}/${step.id} to 不存在`);
      assert.ok(KINDS.has(step.kind), `${scenario.id}/${step.id} kind 无效`);
      assert.ok(step.title && step.detail && step.tag);
      assert.ok(step.at && Number.isFinite(step.atMs));
    }
  }
});
