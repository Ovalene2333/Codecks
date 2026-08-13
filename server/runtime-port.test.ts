import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { configuredRuntimePort, findFreeListenPort } from "./runtime-port.js";

test("configured runtime port is optional and validated", () => {
  assert.equal(configuredRuntimePort({}), undefined);
  assert.equal(
    configuredRuntimePort({ CODEX_DECK_RUNTIME_PORT: "4288" }),
    4288,
  );
  assert.throws(
    () => configuredRuntimePort({ CODEX_DECK_RUNTIME_PORT: "nope" }),
    /无效/,
  );
});

test("findFreeListenPort binds an unused loopback port", async () => {
  const port = await findFreeListenPort();
  assert.ok(port >= 1 && port <= 65535);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
