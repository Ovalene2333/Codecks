import assert from "node:assert/strict";
import test from "node:test";
import {
  deckDepth,
  deckEntry,
  deckRewrite,
  overlayMarkOf,
  routeForPath,
  sessionKeyFromPath,
  sessionPath,
  type DeckHistoryState,
} from "./deck-history.js";

const TOOL_PATHS = new Set(["/terminal", "/git", "/text-editor"]);
const isToolPath = (pathname: string) => TOOL_PATHS.has(pathname);

test("session path round-trips keys containing separators", () => {
  const key = "codex:default:0190ab-cd";
  assert.equal(sessionKeyFromPath(sessionPath(key)), key);
});

test("sessionKeyFromPath ignores other routes and bad encodings", () => {
  assert.equal(sessionKeyFromPath("/"), undefined);
  assert.equal(sessionKeyFromPath("/terminal"), undefined);
  assert.equal(sessionKeyFromPath("/session/"), undefined);
  assert.equal(sessionKeyFromPath("/session/%E0%A4%A"), undefined);
});

test("routeForPath maps workspace, session and tool paths", () => {
  assert.deepEqual(routeForPath("/", isToolPath), {
    page: "workspace",
    view: "workspace",
  });
  assert.deepEqual(routeForPath("/git", isToolPath), {
    page: "tools",
    view: "workspace",
  });
  assert.deepEqual(routeForPath(sessionPath("codex:p:1"), isToolPath), {
    page: "workspace",
    view: "session",
    session: "codex:p:1",
  });
  assert.deepEqual(routeForPath("/monitor", isToolPath), {
    page: "workspace",
    view: "monitor",
  });
});

test("deckEntry increments depth across page pushes", () => {
  const base = deckEntry(undefined, routeForPath("/", isToolPath));
  assert.equal(base.depth, 1);
  const session = deckEntry(
    base,
    routeForPath(sessionPath("claude:p:2"), isToolPath),
  );
  assert.equal(session.depth, 2);
  const tool = deckEntry(session, routeForPath("/git", isToolPath));
  assert.equal(tool.depth, 3);
  assert.equal(tool.page, "tools");
  assert.equal(tool.view, "workspace");
});

test("page entries never inherit overlay placeholders", () => {
  const base = deckEntry(undefined, routeForPath("/", isToolPath));
  const marked: DeckHistoryState = { ...base, overlay: 7 };
  const next = deckEntry(marked, routeForPath("/terminal", isToolPath));
  assert.equal(next.overlay, undefined);
  assert.equal(next.depth, 2);
});

test("deckRewrite keeps depth and overlay placeholder", () => {
  const session = deckEntry(
    deckEntry(undefined, routeForPath("/", isToolPath)),
    routeForPath(sessionPath("codex:p:1"), isToolPath),
  );
  const rewritten = deckRewrite(session, routeForPath("/", isToolPath));
  assert.equal(rewritten.depth, 2);
  assert.equal(rewritten.view, "workspace");
  // 弹层占位属于当前栈顶条目，原地重写必须保留
  const marked: DeckHistoryState = { ...session, overlay: 9 };
  assert.equal(deckRewrite(marked, routeForPath("/", isToolPath)).overlay, 9);
  // 外部条目上没有可继承深度
  assert.equal(
    deckRewrite({ overlay: 3 }, routeForPath("/", isToolPath)).depth,
    1,
  );
});

test("deckDepth treats foreign entries as depth 0", () => {
  assert.equal(deckDepth(undefined), 0);
  assert.equal(deckDepth({}), 0);
  assert.equal(deckDepth({ __codexDeck: true }), 1);
});

test("overlayMarkOf reads only numeric placeholders", () => {
  assert.equal(overlayMarkOf(undefined), 0);
  assert.equal(overlayMarkOf({ overlay: "x" }), 0);
  assert.equal(overlayMarkOf({ __codexDeck: true, overlay: 4 }), 4);
});
