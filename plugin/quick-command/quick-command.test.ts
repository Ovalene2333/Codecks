import assert from "node:assert/strict";
import test from "node:test";
import {
  expandQuickCommand,
  psQuote,
  QuickCommandTool,
  quickCommandShellSpec,
  shQuote,
} from "./quick-command.server.js";
import { commandParamNames } from "./quick-command.types.js";

const cwd = process.cwd();

test("commandParamNames extracts placeholders in order without duplicates", () => {
  assert.deepEqual(
    commandParamNames("git log -n {count} --author {who} && echo {count}"),
    ["count", "who"],
  );
  assert.deepEqual(commandParamNames("ls -la"), []);
  assert.deepEqual(commandParamNames("echo {} {1x} {-bad}"), []);
});

test("expandQuickCommand shell-quotes parameter values", () => {
  assert.equal(
    expandQuickCommand("git checkout {branch}", { branch: "feat/x" }, shQuote),
    "git checkout 'feat/x'",
  );
  assert.equal(
    expandQuickCommand("echo {msg}", { msg: "it's" }, shQuote),
    `echo 'it'"'"'s'`,
  );
  assert.equal(
    expandQuickCommand("echo {msg}", { msg: "it's" }, psQuote),
    "echo 'it''s'",
  );
  // 未提供的占位符保持原样。
  assert.equal(
    expandQuickCommand("echo {a} {b}", { a: "1" }, shQuote),
    "echo '1' {b}",
  );
});

test("quickCommandShellSpec picks the right shell per platform", () => {
  assert.deepEqual(
    quickCommandShellSpec("/work/project", "ls -la", {
      platform: "linux",
      env: { SHELL: "/bin/fish" },
    }),
    { file: "/bin/fish", args: ["-lc", "ls -la"], cwd: "/work/project" },
  );
  assert.deepEqual(
    quickCommandShellSpec("D:\\Code\\project", "ls", {
      platform: "win32",
      useWsl: true,
      processCwd: "D:\\Code\\deck",
    }),
    {
      file: "wsl.exe",
      args: ["--cd", "/mnt/d/Code/project", "--exec", "sh", "-lc", "ls"],
      cwd: "D:\\Code\\deck",
    },
  );
  assert.deepEqual(
    quickCommandShellSpec("D:\\Code\\project", "ls", {
      platform: "win32",
      processCwd: "D:\\Code\\deck",
    }),
    {
      file: "powershell.exe",
      args: ["-NoLogo", "-NonInteractive", "-Command", "ls"],
      cwd: "D:\\Code\\project",
    },
  );
});

test("save/list/remove round-trips shortcuts", async () => {
  const tool = new QuickCommandTool({ processCwd: cwd });
  assert.deepEqual(await tool.run({ action: "list" }), { commands: [] });
  const { saved } = (await tool.run({
    action: "save",
    name: "看状态",
    command: "git status -s",
  })) as any;
  const { commands } = (await tool.run({ action: "list" })) as any;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "看状态");
  assert.equal(commands[0].id, saved.id);

  const after = (await tool.run({
    action: "save",
    id: saved.id,
    name: "改名",
    command: "git status",
  })) as any;
  assert.equal(after.commands[0].name, "改名");
  assert.equal(after.commands[0].command, "git status");

  const removed = (await tool.run({
    action: "remove",
    id: saved.id,
  })) as any;
  assert.deepEqual(removed.commands, []);
});

test("save binds commands to a directory and empty cwd unbinds them", async () => {
  const tool = new QuickCommandTool({ processCwd: cwd });
  const { saved } = (await tool.run({
    action: "save",
    name: "绑定",
    command: "pwd",
    cwd: "/work/a",
  })) as any;
  assert.equal(saved.cwd, "/work/a");

  const rebound = (await tool.run({
    action: "save",
    id: saved.id,
    name: "绑定",
    command: "pwd",
    cwd: "/work/b",
  })) as any;
  assert.equal(rebound.saved.cwd, "/work/b");

  const cleared = (await tool.run({
    action: "save",
    id: saved.id,
    name: "绑定",
    command: "pwd",
    cwd: "",
  })) as any;
  assert.equal(cleared.saved.cwd, undefined);
});

test("exec runs the expanded command through the shell spec", async () => {
  const calls: { spec: any; timeoutMs: number }[] = [];
  const tool = new QuickCommandTool({
    platform: "linux",
    env: { SHELL: "/bin/bash" },
    processCwd: cwd,
    exec: async (spec, timeoutMs) => {
      calls.push({ spec, timeoutMs });
      return {
        stdout: "ok\n",
        stderr: "",
        code: 0,
        timedOut: false,
        truncated: false,
      };
    },
  });
  const result = (await tool.run({
    action: "exec",
    cwd,
    command: "echo {who}",
    params: { who: "world" },
  })) as any;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.command, "echo 'world'");
  assert.deepEqual(calls[0].spec, {
    file: "/bin/bash",
    args: ["-lc", "echo 'world'"],
    cwd,
  });
});

test("exec surfaces non-zero exits as results, not errors", async () => {
  const tool = new QuickCommandTool({
    platform: "linux",
    processCwd: cwd,
    exec: async () => ({
      stdout: "",
      stderr: "boom",
      code: 3,
      timedOut: false,
      truncated: false,
    }),
  });
  const result = (await tool.run({
    action: "exec",
    cwd,
    command: "false",
  })) as any;
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "boom");
});

test("exec rejects missing params and invalid directories", async () => {
  const tool = new QuickCommandTool({
    platform: "linux",
    processCwd: cwd,
    exec: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
    }),
  });
  await assert.rejects(
    tool.run({ action: "exec", cwd, command: "echo {who}" }),
    /缺少参数：who/,
  );
  await assert.rejects(
    tool.run({ action: "exec", cwd: "relative/dir", command: "ls" }),
    /绝对路径/,
  );
  await assert.rejects(
    tool.run({ action: "exec", cwd: "/definitely/not/there", command: "ls" }),
    /不存在/,
  );
});
