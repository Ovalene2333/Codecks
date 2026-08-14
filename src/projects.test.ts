import test from "node:test";
import assert from "node:assert/strict";
import {
  filterProjectGroups,
  mergeProjectGroups,
  normalizeProjectPath,
  previewSessions,
  threadsForProject,
} from "./projects";
import type { ThreadSummary } from "./types";

const thread = (cwd: string, id = "t1"): ThreadSummary => ({
  id,
  providerId: "p",
  name: "会话",
  preview: "preview",
  cwd,
  model: "gpt",
  status: "idle",
  updatedAt: 2,
});

test("hidden project with sessions is still listed", () => {
  const groups = mergeProjectGroups(
    [
      {
        key: "/tmp/p",
        cwd: "/tmp/p",
        hidden: true,
        updatedAt: 1,
      },
    ],
    [thread("/tmp/p")],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hidden, true);
  assert.equal(groups[0].sessions.length, 1);
});

test("hidden project without sessions is omitted", () => {
  const groups = mergeProjectGroups(
    [{ key: "/tmp/p", cwd: "/tmp/p", hidden: true, updatedAt: 1 }],
    [],
  );
  assert.equal(groups.length, 0);
});

test("windows mnt hybrid paths collapse onto the wsl project key", () => {
  assert.equal(
    normalizeProjectPath("D:\\mnt\\d\\Work\\sample_project"),
    "/mnt/d/work/sample_project",
  );
  assert.equal(
    normalizeProjectPath("/mnt/d/mnt/d/Work/sample_project"),
    "/mnt/d/work/sample_project",
  );
});

test("mergeProjectGroups collapses record and thread path aliases", () => {
  const groups = mergeProjectGroups(
    [
      {
        key: "/mnt/d/work/sample_project",
        cwd: "/mnt/d/Work/sample_project",
        updatedAt: 1,
      },
    ],
    [thread("D:\\mnt\\d\\Work\\sample_project")],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[0].key, "/mnt/d/work/sample_project");
});

test("previewSessions keeps only the latest task until expanded", () => {
  const sessions = [thread("/tmp/a", "a"), thread("/tmp/a", "b"), thread("/tmp/a", "c")];
  assert.deepEqual(
    previewSessions(sessions, false).map((item) => item.id),
    ["a"],
  );
  assert.equal(previewSessions(sessions, true).length, 3);
});

test("filterProjectGroups matches project, session, model, and provider", () => {
  const groups = mergeProjectGroups(
    [],
    [
      { ...thread("/tmp/slam_learning_journey", "a"), name: "新会话", model: "gpt-5.6-sol" },
      { ...thread("/tmp/other", "b"), name: "文档", preview: "改 README", model: "gpt" },
    ],
  );
  const byProject = filterProjectGroups(groups, "slam");
  assert.equal(byProject.length, 1);
  assert.equal(byProject[0].sessions.length, 1);

  const bySession = filterProjectGroups(groups, "readme");
  assert.equal(bySession.length, 1);
  assert.equal(bySession[0].sessions[0].id, "b");

  const byProvider = filterProjectGroups(groups, "official", {
    providerName: () => "OpenAI Official",
  });
  assert.equal(byProvider.length, 2);
});

test("threadsForProject matches normalized windows and unix paths", () => {
  const found = threadsForProject(
    [
      thread("D:\\work\\App", "a"),
      thread("/mnt/d/work/app", "b"),
      thread("/tmp/other", "c"),
    ],
    normalizeProjectPath("D:/work/App"),
  );
  assert.deepEqual(
    found.map((item) => item.id),
    ["a", "b"],
  );
});
