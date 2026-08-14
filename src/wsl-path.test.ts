import assert from "node:assert/strict";
import test from "node:test";
import { isWslCwd, toWslCwd } from "./wsl-path.js";

test("toWslCwd converts Windows drive paths and leaves POSIX alone", () => {
  assert.equal(toWslCwd("D:\\Code\\codex_auto_pilot"), "/mnt/d/Code/codex_auto_pilot");
  assert.equal(toWslCwd("C:\\"), "/mnt/c");
  assert.equal(toWslCwd("/home/tester/repo"), "/home/tester/repo");
  assert.equal(
    toWslCwd("\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo"),
    "/home/tester/repo",
  );
});

test("isWslCwd detects POSIX and \\\\wsl paths", () => {
  assert.equal(isWslCwd("D:\\Code\\project"), false);
  assert.equal(isWslCwd("/mnt/d/Code/project"), true);
  assert.equal(isWslCwd("\\\\wsl$\\Ubuntu\\home\\a"), true);
  assert.equal(isWslCwd("  "), false);
});
