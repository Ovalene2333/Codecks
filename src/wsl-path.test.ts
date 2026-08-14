import assert from "node:assert/strict";
import test from "node:test";
import {
  isMntDriveCwd,
  isWslCwd,
  toggleWslCwd,
  toWindowsCwd,
  toWslCwd,
} from "./wsl-path.js";

test("toWslCwd converts Windows drive paths and leaves POSIX alone", () => {
  assert.equal(toWslCwd("D:\\Code\\codex_auto_pilot"), "/mnt/d/Code/codex_auto_pilot");
  assert.equal(toWslCwd("C:\\"), "/mnt/c");
  assert.equal(toWslCwd("/home/tester/repo"), "/home/tester/repo");
  assert.equal(
    toWslCwd("\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo"),
    "/home/tester/repo",
  );
});

test("toWindowsCwd reverses /mnt drive paths and leaves Linux homes alone", () => {
  assert.equal(toWindowsCwd("/mnt/d/Code/codex_auto_pilot"), "D:\\Code\\codex_auto_pilot");
  assert.equal(toWindowsCwd("/mnt/c"), "C:\\");
  assert.equal(toWindowsCwd("/home/tester/repo"), "/home/tester/repo");
  assert.equal(toWindowsCwd("D:\\Code\\demo"), "D:\\Code\\demo");
});

test("toggleWslCwd flips drive-letter paths both ways", () => {
  assert.equal(
    toggleWslCwd("D:\\Code\\codex_auto_pilot"),
    "/mnt/d/Code/codex_auto_pilot",
  );
  assert.equal(
    toggleWslCwd("/mnt/d/Code/codex_auto_pilot"),
    "D:\\Code\\codex_auto_pilot",
  );
  assert.equal(toggleWslCwd("/home/tester/repo"), "/home/tester/repo");
});

test("isWslCwd detects POSIX and \\\\wsl paths", () => {
  assert.equal(isWslCwd("D:\\Code\\project"), false);
  assert.equal(isWslCwd("/mnt/d/Code/project"), true);
  assert.equal(isWslCwd("\\\\wsl$\\Ubuntu\\home\\a"), true);
  assert.equal(isWslCwd("  "), false);
});

test("isMntDriveCwd is true only for paths that map to a Windows drive", () => {
  assert.equal(isMntDriveCwd("D:\\Code\\project"), true);
  assert.equal(isMntDriveCwd("/mnt/d/Code/project"), true);
  assert.equal(isMntDriveCwd("/home/tester/repo"), false);
});
