import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseWindowsSandboxMode,
  resolveRuntimeCodexHome,
} from "./runtime-home.js";

test("windows sandbox mode is read from the native [windows] table", () => {
  assert.equal(
    parseWindowsSandboxMode('approval_policy = "on-request"\n'),
    undefined,
  );
  assert.equal(
    parseWindowsSandboxMode('[windows]\nsandbox = "elevated"\n'),
    "elevated",
  );
  assert.equal(
    parseWindowsSandboxMode(
      '[tui]\nfoo = 1\n\n[windows]\nsandbox = "unelevated"\n\n[features]\njs_repl = false\n',
    ),
    "unelevated",
  );
});

test("legacy runtime home resolves to the native home behind its sessions junction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-runtime-home-"));
  const dataDir = path.join(root, ".data");
  const legacyHome = path.join(dataDir, "runtime-home");
  const nativeHome = path.join(root, "native", ".codex");
  await mkdir(path.join(nativeHome, "sessions"), { recursive: true });
  await mkdir(legacyHome, { recursive: true });
  await symlink(
    path.join(nativeHome, "sessions"),
    path.join(legacyHome, "sessions"),
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.equal(
    await realpath(await resolveRuntimeCodexHome(legacyHome, dataDir)),
    await realpath(nativeHome),
  );
});

test("an explicitly configured non-legacy Codex home is preserved", async () => {
  const configured = path.resolve("custom-codex-home");
  assert.equal(
    await resolveRuntimeCodexHome(configured, path.resolve(".data")),
    configured,
  );
});

test("WSL mode uses the WSL native Codex home without Windows path resolution", async () => {
  assert.equal(
    await resolveRuntimeCodexHome(undefined, path.resolve(".data"), {
      useWsl: true,
      wslHome: "/home/tester",
    }),
    "/home/tester/.codex",
  );
  assert.equal(
    await resolveRuntimeCodexHome("/srv/codex", path.resolve(".data"), {
      useWsl: true,
      wslHome: "/home/tester",
    }),
    "/srv/codex",
  );
});
