import assert from "node:assert/strict";
import test from "node:test";
import {
  FOLD_OUTPUT_CHARS,
  TURN_SLICE_PARTIAL_KEY,
  foldItem,
  foldTurns,
  sliceTurnsPage,
} from "./turn-fold.js";

const big = "x".repeat(FOLD_OUTPUT_CHARS + 100);

test("foldItem leaves small outputs and unknown types untouched", () => {
  const small = { id: "a", type: "commandExecution", command: "ls", aggregatedOutput: "ok" };
  assert.equal(foldItem(small), small);
  const text = { id: "b", type: "agentMessage", text: big };
  assert.equal(foldItem(text), text);
  const ext = { id: "c", type: "extension", kind: "todo", payload: { big } };
  assert.equal(foldItem(ext), ext);
});

test("foldItem folds big command outputs but keeps small inputs for the summary", () => {
  const item = {
    id: "a",
    type: "commandExecution",
    command: "ls",
    status: "completed",
    tool: "bash",
    input: { command: "ls" },
    metadata: { todos: [{ content: "t" }] },
    todos: [{ content: "t" }],
    aggregatedOutput: big,
    startedAt: 1,
    endedAt: 2,
  };
  const folded: any = foldItem(item);
  assert.notEqual(folded, item);
  assert.equal(folded.folded, true);
  assert.equal(folded.outputChars, big.length);
  assert.equal(folded.outputPreview, big.slice(0, 240));
  assert.equal(folded.aggregatedOutput, undefined);
  assert.equal(folded.metadata, undefined);
  // summary 用的小 input 和计时保留。
  assert.deepEqual(folded.input, { command: "ls" });
  assert.equal(folded.startedAt, 1);
  assert.equal(folded.endedAt, 2);
  assert.deepEqual(folded.todos, [{ content: "t" }]);
  // 原对象不动（ACP 等返回内存对象）。
  assert.equal(item.aggregatedOutput, big);
});

test("foldItem drops big inputs and file diffs", () => {
  const cmd: any = foldItem({
    id: "a",
    type: "commandExecution",
    command: "run",
    aggregatedOutput: big,
    input: { blob: "y".repeat(5_000) },
  });
  assert.equal(cmd.input, undefined);
  const file: any = foldItem({
    id: "f",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "a.ts", kind: "edit", diff: big },
      { path: "b.ts", kind: "add", diff: "tiny" },
    ],
  });
  assert.equal(file.folded, true);
  assert.equal(file.outputChars, big.length + 4);
  assert.deepEqual(
    file.changes.map((change: any) => change.path),
    ["a.ts", "b.ts"],
  );
  assert.ok(!("diff" in file.changes[0]));
});

test("foldTurns only folds non-active completed turns", () => {
  const tool = (id: string) => ({
    id,
    type: "commandExecution",
    command: id,
    aggregatedOutput: big,
  });
  const turns = [
    { id: "t1", status: "completed", items: [tool("a")] },
    { id: "t2", status: "completed", items: [tool("b")] },
    { id: "t3", status: "inProgress", items: [tool("c")] },
  ];
  const folded = foldTurns(turns, "t2");
  assert.equal(folded[0].items[0].folded, true);
  // 活跃回合全文。
  assert.equal(folded[1].items[0].folded, undefined);
  assert.equal(folded[1].items[0].aggregatedOutput, big);
  // 进行中回合全文。
  assert.equal(folded[2].items[0].folded, undefined);
  // 输入数组不动。
  assert.equal(turns[0].items[0].aggregatedOutput, big);
});

test("sliceTurnsPage takes the latest turns and marks the omitted count", () => {
  const turns = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({ id }));
  const page = sliceTurnsPage(turns, 2);
  assert.deepEqual(page.turns.map((turn) => turn.id), ["t4", "t5"]);
  assert.equal(page.totalTurns, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.omitted, 3);
  // 输入不动。
  assert.equal(turns.length, 5);
  // 全量 key 与前端缓存约定一致。
  assert.equal(TURN_SLICE_PARTIAL_KEY, "__cachedTailOmitted");
});

test("sliceTurnsPage pages before a turn and degrades when it is gone", () => {
  const turns = ["t1", "t2", "t3", "t4"].map((id) => ({ id }));
  const page = sliceTurnsPage(turns, 2, "t3");
  assert.deepEqual(page.turns.map((turn) => turn.id), ["t1", "t2"]);
  assert.equal(page.hasMore, false);
  // beforeTurn 被 revert/压缩掉：退化为取最新，不吞数据。
  const gone = sliceTurnsPage(turns, 2, "missing");
  assert.deepEqual(gone.turns.map((turn) => turn.id), ["t3", "t4"]);
  // 取完即全文。
  const all = sliceTurnsPage(turns, 10);
  assert.equal(all.hasMore, false);
  assert.equal(all.omitted, 0);
});
