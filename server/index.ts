import express from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ProviderStore } from "./store.js";
import { ProjectStore } from "./projects.js";
import { listDirectories } from "./fs-browse.js";
import { CodexManager } from "./manager.js";
import { CLI_HELP, parseCli } from "./cli.js";
import { lanAddresses } from "./network.js";
import { startTunnel, type TunnelController } from "./tunnel.js";
import { resolveRuntimeCodexHome } from "./runtime-home.js";
import { shouldUseWslRuntime } from "./runtime-platform.js";
import {
  acquireRuntimeLock,
  clearRuntimeLock,
  updateRuntimeLock,
} from "./runtime-lock.js";
import { startPhase, writeLine } from "./startup-progress.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(
  here,
  "..",
  ...(here.endsWith("dist-server") ? [] : [".."]),
);
for (const file of [
  path.join(process.cwd(), ".env"),
  path.join(projectRoot, ".env"),
]) {
  if (!existsSync(file)) continue;
  try {
    loadEnvFile(file);
  } catch {
    // already-set keys stay; missing file is skipped above
  }
  break;
}

const cli = parseCli(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(CLI_HELP);
  process.exit(0);
}
const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(projectRoot, ".data"),
);
const useWsl = shouldUseWslRuntime(process.platform, cli.wsl);
writeLine(
  process.stdout,
  `Codex Deck 启动中（${useWsl ? "WSL" : process.platform}）`,
);
const wslWake =
  useWsl && !process.env.CODEX_WSL_HOME
    ? startPhase("正在唤醒 WSL，读取用户目录…", {
        waitingLabel: "仍在等待 WSL",
      })
    : undefined;
let codexHome: string;
try {
  codexHome = await resolveRuntimeCodexHome(
    useWsl ? process.env.CODEX_WSL_HOME : process.env.CODEX_HOME,
    dataDir,
    { useWsl },
  );
} catch (error: any) {
  const detail = error?.message || String(error);
  wslWake?.fail(`无法唤醒 WSL：${detail}`);
  if (!wslWake) process.stderr.write(`${detail}\n`);
  process.exit(1);
}
if (wslWake) wslWake.done(`WSL Codex 主目录 ${codexHome}`);
else if (useWsl) writeLine(process.stdout, `WSL Codex 主目录 ${codexHome}`);
const port = cli.port;
const host = cli.host;
const lanListener = host !== "127.0.0.1" && host !== "localhost";
const remote = lanListener || Boolean(cli.tunnel);
const token = cli.noToken
  ? ""
  : cli.token || (remote ? randomBytes(24).toString("base64url") : "");
if (remote && cli.noToken)
  process.stderr.write(
    "\n⚠ 安全警告：--no-token 已关闭鉴权。任何能访问该地址的人都可以操作 Codex、执行命令和修改文件。\n\n",
  );

const store = new ProviderStore(dataDir, codexHome);
const projects = new ProjectStore(dataDir);
await store.load();
await projects.load();
const manager = new CodexManager(
  store,
  dataDir,
  useWsl ? process.env.CODEX_WSL_BIN : process.env.CODEX_BIN,
  undefined,
  useWsl,
);
const fullSnapshot = () => ({
  ...manager.snapshot(),
  projects: projects.list(),
  preferences: projects.getPreferences(),
});
const app = express();
app.use(express.json({ limit: "24mb" }));

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
    runtimeWsl: useWsl,
    authRequired: Boolean(token),
    ccSwitch: store.ccSwitchPath || null,
  }),
);
app.get(
  "/api/snapshot",
  route(async () => fullSnapshot()),
);
app.post(
  "/api/runtime/apply-provider-config",
  route(async () => {
    await manager.applyProviderConfig();
    return fullSnapshot();
  }),
);
app.post(
  "/api/runtime/reload",
  route(async () => {
    const ccs = await store.refreshCcSwitch();
    manager.emit("event", { type: "snapshot", data: fullSnapshot() });
    const busy = manager.busyThreads();
    let restarted = false;
    if (busy.length === 0) {
      await manager.applyProviderConfig();
      restarted = true;
    }
    return {
      ...fullSnapshot(),
      restarted,
      busyCount: busy.length,
      ccSwitch: store.ccSwitchPath || null,
      ccSwitchChanged: ccs.changed,
    };
  }),
);
app.get(
  "/api/runtime/terminal-command",
  route(async (req) => ({
    command: manager.terminalCommand(
      typeof req.query.providerId === "string"
        ? req.query.providerId
        : undefined,
      typeof req.query.cwd === "string" ? req.query.cwd : undefined,
    ),
  })),
);
app.get(
  "/api/projects",
  route(async () => ({
    projects: projects.list(),
    preferences: projects.getPreferences(),
  })),
);
app.put(
  "/api/projects",
  route(async (req) => {
    const input = z
      .object({
        key: z.string().optional(),
        cwd: z.string().optional(),
        name: z.string().optional(),
        pinned: z.boolean().optional(),
        hidden: z.boolean().optional(),
        defaults: z
          .object({
            providerId: z.string().optional(),
            model: z.string().optional(),
            reasoningEffort: z.string().optional(),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional(),
            approvalPolicy: z
              .enum(["untrusted", "on-request", "never"])
              .optional(),
          })
          .optional(),
      })
      .parse(req.body);
    await projects.upsert(input);
    return fullSnapshot();
  }),
);
app.delete(
  "/api/projects",
  route(async (req) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.body);
    await projects.remove(key);
    return fullSnapshot();
  }),
);
app.put(
  "/api/preferences",
  route(async (req) => {
    const input = z
      .object({
        lastProviderId: z.string().optional(),
        lastModel: z.string().optional(),
        lastReasoningEffort: z.string().optional(),
        lastSandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
        lastApprovalPolicy: z
          .enum(["untrusted", "on-request", "never"])
          .optional(),
        recentDirs: z.array(z.string()).optional(),
      })
      .parse(req.body);
    await projects.updatePreferences(input);
    return fullSnapshot();
  }),
);
app.get(
  "/api/fs",
  route(async (req) =>
    listDirectories(
      typeof req.query.path === "string" ? req.query.path : undefined,
    ),
  ),
);
app.get(
  "/api/providers/:id/models",
  route(async (req) => manager.listModels(param(req.params.id))),
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
    await store.upsert(input);
    return fullSnapshot();
  }),
);
app.delete(
  "/api/providers/:id",
  route(async (req) => {
    const id = param(req.params.id);
    await store.remove(id);
    return fullSnapshot();
  }),
);
app.post(
  "/api/refresh",
  route(async () => {
    await manager.refreshAll();
    return fullSnapshot();
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
        reasoningEffort: z.string().optional(),
        personality: z.enum(["friendly", "pragmatic", "none"]).optional(),
        approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
      })
      .parse(req.body);
    const thread = await manager.createThread(input.providerId, input);
    await projects.rememberCreate({
      cwd: input.cwd,
      providerId: input.providerId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
    });
    return thread;
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
    const input = z
      .object({
        text: z.string().max(100_000).optional().default(""),
        images: z
          .array(
            z.object({
              url: z.string().min(1).max(20_000_000),
              name: z.string().max(200).optional(),
            }),
          )
          .max(8)
          .optional(),
      })
      .parse(req.body || {});
    return manager.sendTurn(
      param(req.params.providerId),
      param(req.params.threadId),
      input.text,
      input.images,
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
app.patch(
  "/api/threads/:providerId/:threadId",
  route(async (req) => {
    const providerId = param(req.params.providerId);
    const threadId = param(req.params.threadId);
    const input = z
      .object({
        name: z.string().min(1).optional(),
        settings: z
          .object({
            model: z.string().optional(),
            reasoningEffort: z.string().optional(),
            personality: z.enum(["friendly", "pragmatic", "none"]).optional(),
            approvalPolicy: z
              .enum(["untrusted", "on-request", "never"])
              .optional(),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional(),
          })
          .optional(),
      })
      .parse(req.body);
    if (input.name)
      await manager.renameThread(providerId, threadId, input.name);
    if (input.settings)
      await manager.updateThreadSettings(providerId, threadId, input.settings);
    return fullSnapshot();
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/fork",
  route(async (req) => {
    const input = z
      .object({ lastTurnId: z.string().optional() })
      .parse(req.body || {});
    return manager.forkThread(
      param(req.params.providerId),
      param(req.params.threadId),
      input,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/compact",
  route(async (req) =>
    manager.compactThread(
      param(req.params.providerId),
      param(req.params.threadId),
    ),
  ),
);
app.post(
  "/api/threads/:providerId/:threadId/review",
  route(async (req) => {
    const input = z
      .object({
        target: z
          .enum(["uncommittedChanges", "baseBranch", "commit", "custom"])
          .optional(),
        branch: z.string().min(1).optional(),
        sha: z.string().min(1).optional(),
        title: z.string().optional(),
        instructions: z.string().optional(),
        delivery: z.enum(["inline", "detached"]).optional(),
      })
      .parse(req.body || {});
    return manager.reviewThread(
      param(req.params.providerId),
      param(req.params.threadId),
      {
        type: input.target || "uncommittedChanges",
        branch: input.branch,
        sha: input.sha,
        title: input.title,
        instructions: input.instructions,
      },
      input.delivery,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/shell",
  route(async (req) => {
    const { command } = z
      .object({ command: z.string().min(1).max(20_000) })
      .parse(req.body);
    return manager.runShellCommand(
      param(req.params.providerId),
      param(req.params.threadId),
      command,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/goal",
  route(async (req) => {
    const input = z
      .object({ objective: z.string().max(20_000).nullable().optional() })
      .parse(req.body || {});
    return manager.setThreadGoal(
      param(req.params.providerId),
      param(req.params.threadId),
      input.objective,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/init",
  route(async (req) =>
    manager.sendInitTurn(
      param(req.params.providerId),
      param(req.params.threadId),
    ),
  ),
);
app.post(
  "/api/threads/:providerId/:threadId/plan",
  route(async (req) =>
    manager.sendPlanTurn(
      param(req.params.providerId),
      param(req.params.threadId),
    ),
  ),
);
app.post(
  "/api/threads/:providerId/:threadId/diff",
  route(async (req) =>
    manager.showDiff(
      param(req.params.providerId),
      param(req.params.threadId),
    ),
  ),
);
app.post(
  "/api/threads/:providerId/:threadId/migrate",
  route(async (req) => {
    const input = z
      .object({
        targetProviderId: z.string().min(1),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
      })
      .parse(req.body);
    const thread = await manager.migrateThread(
      param(req.params.providerId),
      param(req.params.threadId),
      input.targetProviderId,
      input,
    );
    await projects.rememberCreate({
      cwd: thread.cwd,
      providerId: input.targetProviderId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });
    return thread;
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/archive",
  route(async (req) => {
    await manager.archiveThread(
      param(req.params.providerId),
      param(req.params.threadId),
    );
    return fullSnapshot();
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/unarchive",
  route(async (req) => {
    await manager.unarchiveThread(
      param(req.params.providerId),
      param(req.params.threadId),
    );
    return fullSnapshot();
  }),
);
app.delete(
  "/api/threads/:providerId/:threadId",
  route(async (req) => {
    await manager.deleteThread(
      param(req.params.providerId),
      param(req.params.threadId),
    );
    return fullSnapshot();
  }),
);
app.post(
  "/api/approvals/:id",
  route(async (req) => {
    const input = z
      .object({
        decision: z
          .enum(["accept", "acceptForSession", "decline", "cancel"])
          .optional(),
        permissions: z.unknown().optional(),
        scope: z.enum(["session", "turn"]).optional(),
        answers: z.unknown().optional(),
      })
      .parse(req.body);
    return manager.resolveApproval(param(req.params.id), input);
  }),
);
app.post(
  "/api/runtime/rate-limits",
  route(async () => manager.loadOfficialUsage()),
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
  ws.send(JSON.stringify({ type: "snapshot", data: fullSnapshot() })),
);
manager.on("event", (event) => {
  if (event.type === "runtime.process") {
    updateRuntimeLock(dataDir, {
      childPid: event.data?.pid,
      listen: event.data?.remoteUrl,
    });
    return;
  }
  const payload = JSON.stringify(
    event.type === "snapshot"
      ? { type: "snapshot", data: fullSnapshot() }
      : event,
  );
  for (const client of wss.clients)
    if (client.readyState === WebSocket.OPEN) client.send(payload);
});

let lock = acquireRuntimeLock(dataDir, {
  pid: process.pid,
  port,
  useWsl,
});
for (let attempt = 0; lock.status === "blocked" && attempt < 5; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  lock = acquireRuntimeLock(dataDir, { pid: process.pid, port, useWsl });
}
if (lock.status === "blocked") {
  process.stderr.write(
    `Deck 已在运行 (pid ${lock.lock.pid}, 端口 ${lock.lock.port})。请先退出旧进程，不要同时开两个 --wsl / npm start / npm run dev 后端。\n`,
  );
  process.exit(1);
}

let tunnel: TunnelController | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
} catch (error: any) {
  clearRuntimeLock(dataDir, process.pid);
  if (error?.code === "EADDRINUSE")
    process.stderr.write(
      `端口 ${port} 已被占用。请先结束旧的 Deck 或占用该端口的进程，不要再拉起第二个 app-server。\n`,
    );
  else process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}

console.log(`Codex Deck: http://${host}:${port}`);
if (lanListener) {
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

const runtimeStart = useWsl
  ? startPhase("正在启动 WSL 中的 Codex app-server…", {
      waitingLabel: "仍在等待 app-server",
    })
  : undefined;
manager
  .startAll()
  .then(() => runtimeStart?.done("Codex runtime 已就绪"))
  .catch((error) => {
    runtimeStart?.fail(`Codex 启动失败：${error?.message || error}`);
    console.error("Codex 启动失败:", error);
  });
setInterval(async () => {
  try {
    if (await store.syncCcSwitch()) {
      manager.emit("event", { type: "snapshot", data: fullSnapshot() });
    }
  } catch (error) {
    console.error("CC Switch 同步失败:", error);
  }
}, 5_000).unref();

const shutdown = () => {
  clearRuntimeLock(dataDir, process.pid);
  tunnel?.kill();
  manager.restart();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
