import assert from "node:assert/strict";
import test from "node:test";
import type { Express, Request, Response } from "express";
import type { AgentRegistry } from "./agents/registry.js";
import { installDevApi } from "./dev-api.js";

test("dev api stays off by default and maps approval fields into params", async () => {
  const handlers = new Map<
    string,
    (req: Request, res: Response) => Promise<void>
  >();
  const app = {
    get: (path: string, handler: any) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: any) => handlers.set(`POST ${path}`, handler),
    delete: (path: string, handler: any) =>
      handlers.set(`DELETE ${path}`, handler),
  } as unknown as Express;
  const injected: any[] = [];
  const agents = {
    listDevApprovals: () => injected,
    clearDevApprovals: () => injected.length,
    injectDevApproval: (input: any) => {
      injected.push(input);
      return { id: "dev:1", ...input };
    },
  } as unknown as AgentRegistry;

  assert.equal(installDevApi(app, agents, false), false);
  assert.equal(handlers.size, 0);
  assert.equal(installDevApi(app, agents, true), true);

  const request = async (key: string, body: unknown = {}) => {
    const handler = handlers.get(key);
    assert.ok(handler, `应注册 ${key}`);
    let statusCode = 200;
    let data: any;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        data = value;
        return this;
      },
    } as unknown as Response;
    await handler({ body } as Request, response);
    return { statusCode, data };
  };

  const created = await request("POST /api/dev/approvals", {
    command: ["npm", "test"],
    kind: "command",
    cwd: "/tmp",
    reason: "联调",
    availableDecisions: ["accept", "decline"],
    networkApproval: true,
  });
  assert.equal(created.statusCode, 200);
  const params = created.data.approval.params;
  assert.deepEqual(params.command, ["npm", "test"]);
  assert.equal(params.cwd, "/tmp");
  assert.equal(params.reason, "联调");
  assert.deepEqual(params.availableDecisions, ["accept", "decline"]);
  assert.deepEqual(params.networkApprovalContext, {});

  const listed = await request("GET /api/dev/approvals");
  assert.equal(listed.data.items.length, 1);
  const cleared = await request("DELETE /api/dev/approvals");
  assert.equal(cleared.data.cleared, 1);

  const invalid = await request("POST /api/dev/approvals", { kind: "nope" });
  assert.equal(invalid.statusCode, 400);
});
