import express from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ProviderStore } from "./store.js";
import { CodexManager } from "./manager.js";
import { CLI_HELP, parseCli } from "./cli.js";
import { lanAddresses } from "./network.js";
import { startTunnel, type TunnelController } from "./tunnel.js";

const cli = parseCli(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(CLI_HELP);
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(
  here,
  "..",
  ...(here.endsWith("dist-server") ? [] : [".."]),
);
const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(projectRoot, ".data"),
);
const port = cli.port;
const host = cli.host;
const remote = host !== "127.0.0.1" && host !== "localhost";
const token = cli.noToken
  ? ""
  : cli.token || (remote ? randomBytes(24).toString("base64url") : "");
if (remote && cli.noToken)
  process.stderr.write(
    "\n⚠ 安全警告：--no-token 已关闭鉴权。任何能访问该地址的人都可以操作 Codex、执行命令和修改文件。\n\n",
  );

const store = new ProviderStore(dataDir, process.env.CODEX_HOME);
await store.load();
const manager = new CodexManager(store, dataDir, process.env.CODEX_BIN);
const app = express();
app.use(express.json({ limit: "1mb" }));

const authorized = (value?: string) => {
  if (!token) return true;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
app.use("/api", (req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!authorized(bearer))
    return res.status(401).json({ error: "访问令牌无效" });
  next();
});

const route =
  (handler: (req: express.Request, res: express.Response) => Promise<any>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "请求失败" });
    }
  };
const param = (value: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    platform: process.platform,
    wsl: Boolean(process.env.WSL_DISTRO_NAME),
    authRequired: Boolean(token),
    ccSwitch: store.ccSwitchPath || null,
  }),
);
app.get(
  "/api/snapshot",
  route(async () => manager.snapshot()),
);
app.post(
  "/api/providers",
  route(async (req) => {
    const input = z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        kind: z.enum(["local-profile", "custom"]),
        color: z.string().optional(),
        model: z.string().optional(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        wireApi: z.enum(["responses", "chat"]).optional(),
        codexHome: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const provider = await store.upsert(input);
    manager.restart(provider.id);
    await manager.ensure(provider.id);
    return manager.snapshot();
  }),
);
app.delete(
  "/api/providers/:id",
  route(async (req) => {
    const id = param(req.params.id);
    manager.restart(id);
    await store.remove(id);
    return manager.snapshot();
  }),
);
app.post(
  "/api/refresh",
  route(async () => {
    await manager.refreshAll();
    return manager.snapshot();
  }),
);
app.post(
  "/api/threads",
  route(async (req) => {
    const input = z
      .object({
        providerId: z.string(),
        cwd: z.string().min(1),
        name: z.string().optional(),
        model: z.string().optional(),
        approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
      })
      .parse(req.body);
    return manager.createThread(input.providerId, input);
  }),
);
app.get(
  "/api/threads/:providerId/:threadId",
  route(async (req) =>
    manager.readThread(
      param(req.params.providerId),
      param(req.params.threadId),
    ),
  ),
);
app.post(
  "/api/threads/:providerId/:threadId/turns",
  route(async (req) => {
    const { text } = z
      .object({ text: z.string().min(1).max(100_000) })
      .parse(req.body);
    return manager.sendTurn(
      param(req.params.providerId),
      param(req.params.threadId),
      text,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/interrupt",
  route(async (req) => {
    const { turnId } = z.object({ turnId: z.string() }).parse(req.body);
    return manager.interrupt(
      param(req.params.providerId),
      param(req.params.threadId),
      turnId,
    );
  }),
);
app.post(
  "/api/approvals/:id",
  route(async (req) => {
    const { decision } = z
      .object({
        decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      })
      .parse(req.body);
    return manager.resolveApproval(param(req.params.id), decision);
  }),
);

const webDir = path.join(projectRoot, "dist-web");
app.use(express.static(webDir));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(webDir, "index.html")),
);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (
    url.pathname !== "/ws" ||
    !authorized(url.searchParams.get("token") || undefined)
  )
    return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) =>
  ws.send(JSON.stringify({ type: "snapshot", data: manager.snapshot() })),
);
manager.on("event", (event) => {
  const payload = JSON.stringify(event);
  for (const client of wss.clients)
    if (client.readyState === WebSocket.OPEN) client.send(payload);
});

let tunnel: TunnelController | undefined;
server.listen(port, host, () => {
  console.log(`Codex Deck: http://${host}:${port}`);
  if (remote) {
    const urls = lanAddresses(port, token);
    if (urls.length)
      process.stdout.write(`\n局域网手机入口：\n${urls.join("\n")}\n\n`);
    else
      process.stderr.write(
        "未检测到可用的局域网 IPv4 地址，请检查防火墙或网卡。\n",
      );
  }
  if (cli.tunnel)
    tunnel = startTunnel(cli.tunnel, port, token, cli.cloudflaredBin);
});
manager.startAll().catch((error) => console.error("Codex 启动失败:", error));
setInterval(async () => {
  try {
    if (await store.syncCcSwitch()) {
      for (const provider of store
        .listPublic()
        .filter((p) => p.kind === "cc-switch"))
        manager.restart(provider.id);
      await manager.startAll();
    }
  } catch (error) {
    console.error("CC Switch 同步失败:", error);
  }
}, 5_000).unref();

const shutdown = () => {
  tunnel?.kill();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
