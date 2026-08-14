import assert from "node:assert/strict";
import test from "node:test";
import {
  exposeEnvironmentToWsl,
  shouldUseWslRuntime,
  WSL_CODEX_SHELL_COMMAND,
  windowsPathToWsl,
} from "./runtime-platform.js";

test("--wsl only selects a WSL runtime from a Windows host", () => {
  assert.equal(shouldUseWslRuntime("win32", true), true);
  assert.equal(shouldUseWslRuntime("linux", true), false);
  assert.equal(shouldUseWslRuntime("darwin", true), false);
  assert.equal(shouldUseWslRuntime("win32", false), false);
});

test("WSL Codex startup loads nvm and rejects Windows path shims", () => {
  assert.match(WSL_CODEX_SHELL_COMMAND, /\.nvm\/nvm\.sh/);
  assert.match(WSL_CODEX_SHELL_COMMAND, /\/mnt\/\*/);
  assert.match(WSL_CODEX_SHELL_COMMAND, /exec "\$@"/);
});

test("Windows paths are translated for a WSL runtime", () => {
  assert.equal(windowsPathToWsl("D:\\Code\\deck"), "/mnt/d/Code/deck");
  assert.equal(windowsPathToWsl("C:\\"), "/mnt/c");
  assert.equal(windowsPathToWsl("/home/tester/repo"), "/home/tester/repo");
  assert.equal(
    windowsPathToWsl("\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo"),
    "/home/tester/repo",
  );
});

test("WSLENV forwards runtime variables without discarding existing entries", () => {
  const env = exposeEnvironmentToWsl(
    { WSLENV: "KEEP/u:CODEX_HOME", CODEX_HOME: "/home/tester/.codex", API_KEY: "secret" },
    ["CODEX_HOME", "API_KEY"],
  );
  assert.equal(env.WSLENV, "KEEP/u:CODEX_HOME:API_KEY");
});
