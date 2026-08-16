import assert from "node:assert/strict";
import test from "node:test";
import { GitTool, gitCommandSpec, parseGitStatus } from "./git.server.js";

test("Git status parses staged, modified, untracked, and renamed files", () => {
  assert.deepEqual(
    parseGitStatus(
      "M  staged.ts\0 M changed.ts\0?? note.txt\0R  new.ts\0old.ts\0",
    ),
    [
      {
        path: "staged.ts",
        indexStatus: "M",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
      },
      {
        path: "changed.ts",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
      },
      {
        path: "note.txt",
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
        unstaged: true,
        untracked: true,
      },
      {
        path: "new.ts",
        originalPath: "old.ts",
        indexStatus: "R",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
      },
    ],
  );
});

test("Windows WSL Git runs inside the selected directory", () => {
  assert.deepEqual(
    gitCommandSpec("D:\\Code\\project", ["status", "--short"], {
      platform: "win32",
      useWsl: true,
      processCwd: "D:\\Code\\deck",
    }),
    {
      file: "wsl.exe",
      args: ["--cd", "/mnt/d/Code/project", "git", "status", "--short"],
      cwd: "D:\\Code\\deck",
    },
  );
});

test("Git actions keep user paths after the option separator", async () => {
  const calls: string[][] = [];
  const runGit = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/repo\n";
    if (args[0] === "branch" && args[1] === "--show-current") return "main\n";
    if (args[0] === "branch") return "main\n";
    return "";
  };
  const tool = new GitTool({ runGit });
  await tool.run({ action: "stage", cwd: "/repo", paths: ["-notes.txt"] });
  assert.deepEqual(calls[0], ["add", "--", "-notes.txt"]);
});

test("Git status does not disguise executable failures as an empty directory", async () => {
  const tool = new GitTool({
    runGit: async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    },
  });
  await assert.rejects(
    tool.run({ action: "status", cwd: "/repo" }),
    /spawn git ENOENT/,
  );
});
