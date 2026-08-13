import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexLaunchSpec } from "./codex-client.js";

test("launches Windows cmd shims through cmd.exe to avoid spawn EINVAL", () => {
  assert.deepEqual(
    codexLaunchSpec("codex", "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "codex.cmd", "app-server", "--stdio"],
    },
  );
  assert.deepEqual(
    codexLaunchSpec("C:\\Program Files\\Codex\\codex.cmd", "win32", {
      ComSpec: "cmd.exe",
    }),
    {
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Program Files\\Codex\\codex.cmd",
        "app-server",
        "--stdio",
      ],
    },
  );
});

test("launches native executables directly", () => {
  assert.deepEqual(codexLaunchSpec("codex", "linux", {}), {
    command: "codex",
    args: ["app-server", "--stdio"],
  });
  assert.deepEqual(codexLaunchSpec("C:\\Codex\\codex.exe", "win32", {}), {
    command: "C:\\Codex\\codex.exe",
    args: ["app-server", "--stdio"],
  });
});

test("passes provider overrides as separate argv entries", () => {
  assert.deepEqual(
    codexLaunchSpec("codex", "linux", {}, [
      "-c",
      'model_providers.deck.name="Relay API"',
    ]),
    {
      command: "codex",
      args: [
        "app-server",
        "--stdio",
        "-c",
        'model_providers.deck.name="Relay API"',
      ],
    },
  );
  assert.deepEqual(
    codexLaunchSpec("codex", "win32", { ComSpec: "cmd.exe" }, [
      "-c",
      "model_providers.deck.name='Relay API'",
    ]).args,
    [
      "/d",
      "/s",
      "/c",
      "codex.cmd",
      "app-server",
      "--stdio",
      "-c",
      "model_providers.deck.name='Relay API'",
    ],
  );
});

test("launches a loopback WebSocket runtime for terminal sharing", () => {
  assert.deepEqual(
    codexLaunchSpec("codex", "linux", {}, [], "ws://127.0.0.1:4175"),
    {
      command: "codex",
      args: ["app-server", "--listen", "ws://127.0.0.1:4175"],
    },
  );
});

test("Windows cmd keeps TOML literal strings as their own argv", () => {
  const spec = codexLaunchSpec(
    "codex",
    "win32",
    { ComSpec: "cmd.exe" },
    ["-c", "model_providers.deck.name='Relay API'"],
    "ws://127.0.0.1:4175",
  );
  assert.equal(spec.args.at(-1), "model_providers.deck.name='Relay API'");
  assert.ok(spec.args.includes("--listen"));
  assert.ok(spec.args.includes("ws://127.0.0.1:4175"));
});

test("Windows npm shims launch through node so -c values are not re-quoted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-deck-"));
  try {
    const js = path.join(
      root,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    await mkdir(path.dirname(js), { recursive: true });
    await writeFile(js, "console.log('ok')\n");
    await writeFile(path.join(root, "codex.cmd"), "@echo off\n");
    const spec = codexLaunchSpec(
      "codex",
      "win32",
      { PATH: root, ComSpec: "cmd.exe" },
      ["-c", "model_providers.deck.name='Relay API'"],
      "ws://127.0.0.1:4175",
    );
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [
      js,
      "app-server",
      "--listen",
      "ws://127.0.0.1:4175",
      "-c",
      "model_providers.deck.name='Relay API'",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
