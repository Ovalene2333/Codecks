import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { WebTerminalTool, terminalShellSpec } from "./terminal.server.js";

test("Windows WSL terminal enters the requested Linux cwd", () => {
  assert.deepEqual(
    terminalShellSpec("/mnt/d/code/project", {
      platform: "win32",
      useWsl: true,
      processCwd: "D:\\Code\\deck",
    }),
    {
      file: "wsl.exe",
      args: ["--cd", "/mnt/d/code/project"],
      cwd: "D:\\Code\\deck",
    },
  );
});

test("native terminal uses the configured user shell", () => {
  assert.deepEqual(
    terminalShellSpec("/work/project", {
      platform: "linux",
      env: { SHELL: "/bin/fish" },
    }),
    { file: "/bin/fish", args: ["-l"], cwd: "/work/project" },
  );
});

test("web terminal is published at the canonical terminal route", () => {
  const tool = new WebTerminalTool({ processCwd: process.cwd() });
  assert.equal(tool.descriptor().pagePath, "/terminal");
});

test("Windows WSL terminal converts a Windows project path", () => {
  assert.deepEqual(
    terminalShellSpec("D:\\Code\\project", {
      platform: "win32",
      useWsl: true,
      processCwd: "D:\\Code\\deck",
    }),
    {
      file: "wsl.exe",
      args: ["--cd", "/mnt/d/Code/project"],
      cwd: "D:\\Code\\deck",
    },
  );
});

test("web terminal bridges PTY output, input, resize and close", async () => {
  const writes: string[] = [];
  const resizes: number[][] = [];
  let killed = false;
  let onData = (_data: string) => {};
  let onExit = (_event: { exitCode: number; signal?: number }) => {};
  const fakePty = {
    pid: 4321,
    process: "test-shell",
    handleFlowControl: false,
    write: (data: string) => writes.push(data),
    resize: (cols: number, rows: number) => resizes.push([cols, rows]),
    kill: () => {
      killed = true;
    },
    pause: () => {},
    resume: () => {},
    clear: () => {},
    onData: (listener: typeof onData) => {
      onData = listener;
      return { dispose: () => {} };
    },
    onExit: (listener: typeof onExit) => {
      onExit = listener;
      return { dispose: () => {} };
    },
  };
  const sent: any[] = [];
  const closes: Array<[number, string]> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send: (value: string) => sent.push(JSON.parse(value)),
    close: (code: number, reason: string) => closes.push([code, reason]),
  });
  const tool = new WebTerminalTool({
    platform: process.platform,
    processCwd: process.cwd(),
    spawn: (() => fakePty) as any,
  });
  tool.connect(socket as unknown as WebSocket);
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        cwd: process.cwd(),
        cols: 100,
        rows: 30,
      }),
    ),
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      sent.some(
        (message) => message.type === "ready" || message.type === "error",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(
    sent.find((message) => message.type === "ready")?.pid,
    4321,
    sent.find((message) => message.type === "error")?.message,
  );
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "input", data: "pwd\r" })),
  );
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })),
  );
  onData("terminal output");
  assert.deepEqual(writes, ["pwd\r"]);
  assert.deepEqual(resizes, [[120, 40]]);
  assert.equal(sent.at(-1)?.data, "terminal output");

  onExit({ exitCode: 0 });
  assert.equal(sent.at(-1)?.type, "exit");
  assert.deepEqual(closes, [[1000, "terminal exited"]]);
  socket.emit("close");
  assert.equal(killed, false, "already-exited PTY is not killed twice");
});
