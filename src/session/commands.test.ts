import test from "node:test";
import assert from "node:assert/strict";
import {
  incompleteCommandHint,
  matchingSlashCommands,
  parseComposerCommand,
} from "./commands.ts";

test("parseComposerCommand maps built-in Codex commands", () => {
  assert.deepEqual(parseComposerCommand("/compact"), { kind: "compact" });
  assert.deepEqual(parseComposerCommand("/review"), {
    kind: "review",
    target: { type: "uncommittedChanges" },
  });
  assert.deepEqual(parseComposerCommand("/review base main"), {
    kind: "review",
    target: { type: "baseBranch", branch: "main" },
  });
  assert.deepEqual(parseComposerCommand("/goal 把测试跑绿"), {
    kind: "goal",
    objective: "把测试跑绿",
  });
  assert.deepEqual(parseComposerCommand("/model gpt-5.4 high"), {
    kind: "model",
    model: "gpt-5.4",
    reasoningEffort: "high",
  });
  assert.deepEqual(parseComposerCommand("/permissions"), {
    kind: "permissions",
    sandbox: undefined,
    approvalPolicy: undefined,
  });
  assert.deepEqual(parseComposerCommand("/skills react"), {
    kind: "skills",
    query: "react",
  });
  assert.deepEqual(parseComposerCommand("/mention src/app"), {
    kind: "mention",
    query: "src/app",
  });
  assert.deepEqual(parseComposerCommand("/fast"), {
    kind: "fast",
  });
  assert.deepEqual(parseComposerCommand("/fast off"), {
    kind: "fast",
    enabled: false,
  });
  assert.deepEqual(parseComposerCommand("/mcp verbose"), {
    kind: "mcp",
    verbose: true,
  });
  assert.deepEqual(parseComposerCommand("/usage"), { kind: "usage" });
  assert.deepEqual(parseComposerCommand("!git status --short"), {
    kind: "shell",
    command: "git status --short",
  });
  assert.equal(parseComposerCommand("普通消息"), undefined);
  assert.equal(parseComposerCommand("/unknown"), undefined);
});

test("matchingSlashCommands filters as the user types", () => {
  assert.ok(matchingSlashCommands("/").length >= 14);
  assert.ok(matchingSlashCommands("/").some((item) => item.name === "!"));
  assert.deepEqual(
    matchingSlashCommands("/re").map((item) => item.name),
    ["/review"],
  );
  assert.match(incompleteCommandHint("/goal"), /目标/);
  assert.match(incompleteCommandHint("/fast turbo"), /on\|off/);
  assert.match(incompleteCommandHint("/mcp all"), /verbose/);
});
