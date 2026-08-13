import { createServer } from "node:net";

export function configuredRuntimePort(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.CODEX_DECK_RUNTIME_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`CODEX_DECK_RUNTIME_PORT 无效：${raw}`);
  return port;
}

export function findFreeListenPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("无法分配 Codex runtime 端口"));
        else resolve(port);
      });
    });
  });
}
