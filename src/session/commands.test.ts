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
  assert.deepEqual(parseComposerCommand("!git status --short"), {
    kind: "shell",
    command: "git status --short",
  });
  assert.equal(parseComposerCommand("普通消息"), undefined);
  assert.equal(parseComposerCommand("/unknown"), undefined);
});

test("matchingSlashCommands filters as the user types", () => {
  assert.ok(matchingSlashCommands("/").length >= 6);
  assert.ok(matchingSlashCommands("/").some((item) => item.name === "!"));
  assert.deepEqual(
    matchingSlashCommands("/re").map((item) => item.name),
    ["/review"],
  );
  assert.match(incompleteCommandHint("/goal"), /目标/);
});
