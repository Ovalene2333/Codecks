import assert from "node:assert/strict";
import test from "node:test";
import { killProcessTree, stopChildProcess } from "./process-tree.js";

test("killProcessTree ignores invalid pids without throwing", () => {
  assert.doesNotThrow(() => {
    killProcessTree(0);
    killProcessTree(-1);
    killProcessTree(Number.NaN);
  });
});

test("killProcessTree on a dead pid does not throw", () => {
  // 99999999 几乎不可能存在；即使存在，失败也必须吞掉。
  assert.doesNotThrow(() => killProcessTree(99999999));
});

test("stopChildProcess tolerates missing children", () => {
  assert.doesNotThrow(() => {
    stopChildProcess(undefined);
    stopChildProcess(null);
  });
});

test("stopChildProcess kills the tree before the direct child", () => {
  const order: string[] = [];
  const child = {
    pid: 4242,
    kill: () => {
      order.push("direct");
      return true;
    },
  };
  stopChildProcess(child, (pid) => {
    order.push(`tree:${pid}`);
  });
  assert.deepEqual(order, ["tree:4242", "direct"]);
});

test("stopChildProcess still kills directly when the child has no pid", () => {
  let killed = false;
  let treeCalls = 0;
  stopChildProcess(
    {
      kill: () => {
        killed = true;
        return true;
      },
    },
    () => {
      treeCalls += 1;
    },
  );
  assert.equal(killed, true);
  assert.equal(treeCalls, 0);
});

test("stopChildProcess survives throwing killers", () => {
  assert.doesNotThrow(() =>
    stopChildProcess(
      {
        pid: 1,
        kill: () => {
          throw new Error("already exited");
        },
      },
      () => {
        throw new Error("no taskkill");
      },
    ),
  );
});
