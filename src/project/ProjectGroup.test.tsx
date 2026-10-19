import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectGroup } from "../projects";
import type { SessionSearchMatch } from "../types";
import { ProjectGroupView } from "./ProjectGroup";
import { branchRelations } from "../session-branch";

test("project rows render body-search context and highlight the query", () => {
  const project: ProjectGroup = {
    key: "/work",
    cwd: "/work",
    name: "work",
    updatedAt: 1,
    sessions: [
      {
        agentId: "codex",
        id: "thread-1",
        providerId: "local",
        name: "Session",
        preview: "Preview",
        cwd: "/work",
        model: "gpt-test",
        status: "idle",
        updatedAt: 1,
      },
    ],
  };
  const match: SessionSearchMatch = {
    agentId: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    role: "assistant",
    snippet: "the searchable phrase is here",
    score: -1,
  };
  const html = renderToStaticMarkup(
    <ProjectGroupView
      project={project}
      library="active"
      unseenSessions={new Set()}
      collapsed={false}
      searchQuery="searchable phrase"
      searchMatches={new Map([["codex:thread-1", match]])}
      onToggle={() => undefined}
      onSelect={() => undefined}
      onAdd={() => undefined}
      onPin={() => undefined}
      onHide={() => undefined}
      onRename={() => undefined}
      onDefaults={() => undefined}
      onArchive={() => undefined}
      onRestore={() => undefined}
      onDelete={() => undefined}
      onHistory={() => undefined}
      onSessionMenu={() => undefined}
      providers={[]}
    />,
  );
  assert.match(html, /session-search-hit/);
  assert.match(html, /<mark>searchable phrase<\/mark>/);
  assert.match(html, />Codex<\/small>/);
});

test("branch rows show an explicit badge and child count", () => {
  const project: ProjectGroup = {
    key: "/work",
    cwd: "/work",
    name: "work",
    updatedAt: 3,
    sessions: [
      {
        agentId: "codex",
        id: "root",
        providerId: "local",
        name: "Root",
        preview: "",
        cwd: "/work",
        model: "gpt-test",
        status: "idle",
        updatedAt: 3,
      },
      {
        agentId: "codex",
        id: "branch",
        providerId: "local",
        name: "Branch",
        preview: "",
        cwd: "/work",
        model: "gpt-test",
        status: "idle",
        updatedAt: 2,
        forkedFromId: "root",
      },
    ],
  };
  const html = renderToStaticMarkup(
    <ProjectGroupView
      project={project}
      library="active"
      unseenSessions={new Set()}
      branches={branchRelations(project.sessions)}
      collapsed={false}
      searchQuery=""
      searchMatches={new Map()}
      onToggle={() => undefined}
      onSelect={() => undefined}
      onAdd={() => undefined}
      onPin={() => undefined}
      onHide={() => undefined}
      onRename={() => undefined}
      onDefaults={() => undefined}
      onArchive={() => undefined}
      onRestore={() => undefined}
      onDelete={() => undefined}
      onHistory={() => undefined}
      onSessionMenu={() => undefined}
      providers={[]}
    />,
  );
  assert.match(html, /branch-badge/);
  assert.match(html, /1 分支/);
  assert.match(html, /data-branch-depth="1"/);
  assert.match(html, /aria-label="Branch，分支会话"/);
});
