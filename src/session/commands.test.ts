import test from "node:test";
import assert from "node:assert/strict";
import {
  incompleteCommandHint,
  matchingSlashCommands,
  opensCommandPanel,
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
  });
  assert.deepEqual(parseComposerCommand("/model 这是一句普通问题"), {
    kind: "model",
  });
  assert.deepEqual(parseComposerCommand("/permissions"), {
    kind: "permissions",
    sandbox: undefined,
    approvalMode: undefined,
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
  assert.deepEqual(parseComposerCommand("/ps"), { kind: "ps" });
  assert.deepEqual(parseComposerCommand("!git status --short"), {
    kind: "shell",
    command: "git status --short",
  });
  assert.equal(parseComposerCommand("普通消息"), undefined);
  assert.equal(
    parseComposerCommand("对于/model 等命令应该在点击后显示子选项"),
    undefined,
  );
  assert.equal(parseComposerCommand("/unknown"), undefined);
});

test("panel commands open their interactive selectors", () => {
  assert.equal(opensCommandPanel("/model"), true);
  assert.equal(opensCommandPanel("/permissions"), true);
  assert.equal(opensCommandPanel("/skills"), true);
  assert.equal(opensCommandPanel("/mention"), true);
  assert.equal(opensCommandPanel("/mcp"), true);
  assert.equal(opensCommandPanel("/compact"), false);
});

test("matchingSlashCommands filters as the user types", () => {
  assert.ok(matchingSlashCommands("/").length >= 14);
  assert.ok(matchingSlashCommands("/").some((item) => item.name === "!"));
  assert.deepEqual(
    matchingSlashCommands("/re").map((item) => item.name),
    ["/review"],
  );
  assert.deepEqual(
    matchingSlashCommands("/", "claude").map((item) => item.name),
    ["/status", "/ps", "/usage"],
  );
  assert.match(incompleteCommandHint("/goal"), /目标/);
  assert.match(incompleteCommandHint("/fast turbo"), /on\|off/);
  assert.match(incompleteCommandHint("/mcp all"), /verbose/);
});

test("opencode commands parse to native or passthrough kinds", () => {
  assert.deepEqual(parseComposerCommand("/compact", "opencode"), {
    kind: "compact",
  });
  assert.deepEqual(parseComposerCommand("/summarize", "opencode"), {
    kind: "compact",
  });
  assert.deepEqual(parseComposerCommand("/models", "opencode"), {
    kind: "model",
  });
  assert.deepEqual(parseComposerCommand("/new", "opencode"), {
    kind: "new-session",
  });
  assert.deepEqual(parseComposerCommand("/sessions", "opencode"), {
    kind: "sessions",
  });
  assert.deepEqual(parseComposerCommand("/init AGENTS.md", "opencode"), {
    kind: "opencode-command",
    command: "init",
    args: "AGENTS.md",
  });
  assert.deepEqual(parseComposerCommand("/my-deploy prod", "opencode"), {
    kind: "opencode-command",
    command: "my-deploy",
    args: "prod",
  });
  assert.deepEqual(parseComposerCommand("/undo", "opencode"), { kind: "undo" });
  assert.deepEqual(parseComposerCommand("/redo", "opencode"), { kind: "redo" });
  // Codex 解析不受影响：未知命令仍返回 undefined。
  assert.equal(parseComposerCommand("/my-deploy prod"), undefined);
  assert.equal(parseComposerCommand("/undo"), undefined);
});

test("opencode slash menu merges builtins with server custom commands", () => {
  const items = matchingSlashCommands("/", "opencode", [
    { name: "deploy", hint: "发布" },
    { name: "/compact", hint: "重复项不应出现两次" },
  ]);
  const names = items.map((item) => item.name);
  assert.ok(names.includes("/compact"));
  assert.ok(names.includes("/models"));
  assert.ok(names.includes("/deploy"));
  assert.equal(names.filter((name) => name === "/compact").length, 1);
  assert.deepEqual(
    matchingSlashCommands("/dep", "opencode", [{ name: "deploy" }]).map(
      (item) => item.name,
    ),
    ["/deploy"],
  );
});
