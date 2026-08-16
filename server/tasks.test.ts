import assert from "node:assert/strict";
import test from "node:test";
import { activeTask } from "./tasks.js";

test("activeTask merges running commands with background terminal details", () => {
  const task = activeTask(
    {
      agentId: "codex",
      id: "thread-1",
      providerId: "provider",
      name: "Dev server",
      preview: "run",
      cwd: "/workspace",
      model: "gpt-5.6-sol",
      status: "running",
      activeTurnId: "turn-1",
      updatedAt: 123,
    },
    {
      activeTurnId: "turn-1",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          items: [
            {
              id: "item-1",
              type: "commandExecution",
              status: "inProgress",
              command: "npm run dev",
              processId: "42",
            },
          ],
        },
      ],
    },
    [
      {
        itemId: "item-1",
        processId: "42",
        command: "npm run dev",
        cwd: "/workspace",
        osPid: 99,
      },
    ],
    true,
  );

  assert.equal(task.commands.length, 1);
  assert.equal(task.commands[0].status, "background");
  assert.equal(task.commands[0].osPid, 99);
  assert.equal(task.processControl, true);
});
