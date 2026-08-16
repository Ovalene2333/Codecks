import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostTerminalTool, terminalLaunchSpecs } from "./host-terminal.js";

test("Windows WSL terminal opens the requested Linux cwd", () => {
  const specs = terminalLaunchSpecs("/home/dev/project", "win32", true, {
    SystemRoot: "C:\\Windows",
  });
  assert.deepEqual(specs[0], {
    command: "wt.exe",
    args: ["wsl.exe", "--cd", "/home/dev/project"],
  });
  assert.match(specs[1].args.at(-1) || "", /Start-Process/);
});

test("host terminal tool validates cwd and launches through an injected process", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "deck-terminal-"));
  const calls: any[] = [];
  const fakeSpawn = ((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as any;
    child.unref = () => undefined;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as any;
  const tool = new HostTerminalTool({
    platform: "linux",
    env: { TERMINAL: "test-terminal" },
    spawn: fakeSpawn,
  });

  const result = await tool.run({ cwd });

  assert.deepEqual(result, { ok: true, toolId: "host-terminal", cwd });
  assert.equal(calls[0].command, "test-terminal");
  assert.equal(calls[0].options.cwd, cwd);
});
