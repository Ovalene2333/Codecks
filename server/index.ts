import { closeCliProbes } from "./cli-probe-work.js";
import { startEventLoopHealth } from "./event-loop-health.js";
import compression from "compression";
import express from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ProviderStore } from "./store.js";
import { ClaudeProviderStore, claudeProviderInput } from "./claude-profiles.js";
import {
  pickConnectionOverlay,
  ProjectStore,
  sameConnectionOverlay,
} from "./projects.js";
import { listDirectories } from "./fs-browse.js";
import { resolveExplicitRecipient } from "./deck-recipients.js";
import { GitContextProbe } from "./git-context.js";
import { parseWorktreePorcelain, WorktreeStore } from "./worktrees.js";
import { execFile } from "node:child_process";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";
import { createOpenCodeRuntime } from "./opencode-runtime.js";
import { listLocalAgentBins, probeLocalAgentBin, type LocalAgent } from "./local-agent-bins.js";
import { AcpAdapter } from "./agents/acp-adapter.js";
import {
  ensureAcpAgentsExample,
  loadAcpAgentEntries,
} from "./agents/acp-agents.js";
import { AcpAgentHost } from "./agents/acp-host.js";
import { AgentRegistry } from "./agents/registry.js";
import { prepareThreadResponse, TURN_SLICE_PARTIAL_KEY } from "./agents/turn-fold.js";
import { registerMessageRoutes } from "./message-api.js";
import { installDevApi } from "./dev-api.js";
import { MessageDeliveryQueue } from "./message-delivery.js";
import type { AgentId } from "./agents/types.js";
import type { ThreadSummary } from "./types.js";
import { CLI_HELP, parseCli } from "./cli.js";
import { formatHost, isIpv6Host, lanAddresses } from "./network.js";
import { Pairing, PairRateLimiter } from "./pairing.js";
import { printQrCode } from "./terminal-qr.js";
import { startTunnel, type TunnelController } from "./tunnel.js";
import { installWslScripts, resolveRuntimeCodexHome, resolveWslDeckHome, resolveWslHome, writeWslDiscovery } from "./runtime-home.js";
import { shouldUseWslRuntime } from "./runtime-platform.js";
import {
  acquireRuntimeLock,
  clearRuntimeLock,
  updateRuntimeLock,
} from "./runtime-lock.js";
import { startPhase, writeLine } from "./startup-progress.js";
import { ThreadSummaryCache } from "./thread-summary-cache.js";
import { ActivityTracker } from "./activity.js";
import { backgroundWork, closeBackgroundWork, BackgroundWorkError } from "./background-work.js";
import type { HostStats as BackgroundHostStats } from "./types.js";
import { ThreadSettingsStore } from "./thread-settings.js";
import { ModelAffinityStore } from "./model-affinity.js";
import { AgentSettingsStore } from "./agent-settings.js";
import { BackgroundSearchStore } from "./session-search-background.js";
import { SessionSearchIndexer } from "./session-search-indexer.js";
import { WakeOutbox } from "./wake-outbox.js";
import { AskSettingsStore, askConfigurationSchema, resolveAskConfiguration } from "./ask-settings.js";
import { AskService } from "./ask-service.js";
import {
  listWakeWatchers,
  readTail,
  readWslTail,
  stopWatcherProcess,
  verifyWatcherProcess,
  WakeWatcherCache,
} from "./wake-watchers.js";
import { WakeWatcherLedger } from "./wake-ledger.js";
import {
  ancestorPids,
  bindingConflict,
  describeThread,
  resolveWakeSession,
} from "./wake-resolve.js";
import { referencedThreadImages, resolveThreadImage } from "./thread-image.js";
import {
  deleteOpenCodeProvider,
  listOpenCodeProviders,
  readOpenCodeConfig,
  readOpenCodePermissions,
  upsertOpenCodeProvider,
  writeOpenCodeConfig,
  writeOpenCodePermission,
  type OpenCodeProviderFile,
} from "./opencode-config.js";
import { ToolRegistry } from "../plugin/server-registry.js";
import { GitTool } from "../plugin/git/git.server.js";
import { WebTerminalTool } from "../plugin/terminal/terminal.server.js";
import { TextFilesTool } from "../plugin/text-files/text-files.server.js";
import { QuickCommandTool } from "../plugin/quick-command/quick-command.server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(
  here,
  path.basename(path.dirname(here)) === "dist-server" ? "../.." : "..",
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
let wslHome: string | undefined;
let wslDeckHome: string | undefined;
try {
  if (useWsl) {
    wslHome = await resolveWslHome();
    wslDeckHome = await resolveWslDeckHome().catch(() =>
      path.posix.join(wslHome!, ".codex-deck"),
    );
  }
  codexHome = await resolveRuntimeCodexHome(
    useWsl ? process.env.CODEX_WSL_HOME : process.env.CODEX_HOME,
    dataDir,
    { useWsl, wslHome },
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
const ipv6Host = isIpv6Host(host);
const lanListener =
  host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
const remote = lanListener || Boolean(cli.tunnel);
const token = cli.noToken
  ? ""
  : cli.token || (remote ? randomBytes(24).toString("base64url") : "");
const pairing =
  remote && !cli.noToken && !cli.token ? new Pairing(token) : undefined;
const pairLimiter = pairing ? new PairRateLimiter() : undefined;
/** 本机发现目录：url/token 供 deck-api 读取，watch/ 下是 watcher 日志。 */
const deckHome = path.resolve(
  process.env.CODEX_DECK_HOME || path.join(os.homedir(), ".codex-deck"),
);
if (remote && cli.noToken)
  process.stderr.write(
    "\n⚠ 安全警告：--no-token 已关闭鉴权。任何能访问该地址的人都可以操作 Codex、执行命令和修改文件。\n\n",
  );

const store = new ProviderStore(dataDir, codexHome);
const claudeProviders = new ClaudeProviderStore(dataDir);
const projects = new ProjectStore(dataDir);
const threadSummaries = new ThreadSummaryCache(dataDir);
const threadSettings = new ThreadSettingsStore(dataDir);
const modelAffinity = new ModelAffinityStore(dataDir);
const agentSettings = new AgentSettingsStore(dataDir);
const [, , cachedThreads] = await Promise.all([
  store.load(),
  projects.load(),
  threadSummaries.load(),
  threadSettings.load(),
  modelAffinity.load(),
  agentSettings.load(),
  claudeProviders.load(),
]);
const initialThreads = [
  ...cachedThreads.threads,
  ...cachedThreads.archivedThreads,
];
await threadSettings.seedFromThreads(initialThreads);
const manager = new CodexAdapter(
  store,
  dataDir,
  useWsl ? process.env.CODEX_WSL_BIN : process.env.CODEX_BIN,
  undefined,
  useWsl,
  projects,
  initialThreads,
  cachedThreads.savedAt === 0,
  threadSettings,
);
const claude = new ClaudeAdapter({
  claudeHome:
    process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || undefined,
  claudeBin: process.env.CLAUDE_BIN || store.runtimeAgentBin("claude") || undefined,
  claudeWslBin: process.env.CLAUDE_WSL_BIN || undefined,
  useWsl,
  profileSource: async () => {
    await claudeProviders.load();
    return [...claudeProviders.profiles(), ...store.claudeProfiles()];
  },
  historyIndexFile: path.join(dataDir, "claude-history-index.json"),
  initialThreads,
  threadSettings,
});
const opencodeOptions = {
  initialThreads,
  initialDirectories: [
    ...projects.list().map((project) => project.cwd),
    ...projects.getPreferences().recentDirs,
    ...initialThreads.map((thread) => thread.cwd),
  ],
  threadSettings,
};
const opencodeEnvBin = process.env.OPENCODE_BIN || process.env.OPENCODE_V2_BIN;
const opencode = createOpenCodeRuntime({
  bin: opencodeEnvBin || store.runtimeAgentBin("opencode") || undefined,
  v1: opencodeOptions,
  v2: opencodeOptions,
});
// ACP agents（devin acp、kimi acp 等）：descriptor 驱动，启动失败的 agent
// 只在 startAll 里表现为 offline，不影响其它 adapter。
await ensureAcpAgentsExample(dataDir);
const acpDirectories = () =>
  [
    ...projects.list().map((project) => project.cwd),
    ...projects.getPreferences().recentDirs,
    ...initialThreads.map((thread) => thread.cwd),
  ].filter(Boolean);
// Codex 是核心 agent（供应商/Runtime 都挂在它上面），不可停用；其余 agent
// 按用户在设置里的显式选择加载，没有选择过就走默认（见 loadAcpAgentEntries）。
const agents = new AgentRegistry();
agents.register(manager, { toggleable: false });
agents.register(claude, { enabled: agentSettings.enabled("claude") });
agents.register(opencode, {
  enabled: agentSettings.enabled("opencode"),
});
const acpHost = new AcpAgentHost({
  registry: agents,
  settings: agentSettings,
  load: () => loadAcpAgentEntries(dataDir),
  create: (spec, carried) =>
    new AcpAdapter(spec, {
      threadSettings,
      initialThreads: carried ?? initialThreads,
      directories: acpDirectories(),
    }),
});
await acpHost.sync();
const sessionSearch = new SessionSearchIndexer(
  new BackgroundSearchStore(dataDir),
  agents,
);
const tools = new ToolRegistry([
  new WebTerminalTool({ useWsl, processCwd: projectRoot }),
  new GitTool({ useWsl, processCwd: projectRoot }),
  new TextFilesTool({ useWsl, processCwd: projectRoot }),
  new QuickCommandTool({
    useWsl,
    processCwd: projectRoot,
    file: path.join(dataDir, "quick-commands.json"),
  }),
]);
const activity = new ActivityTracker();

// 唤醒发件箱：POST /api/wake/:code 落盘即 202，送达由它在后台重试到成；
// 持久化在 .data/wake-outbox.json，Deck 重启不丢。
let routingReady = false;
const SNAPSHOT_WINDOW_MS = 50;
// 慢客户端积压超过该阈值即跳过本次推送：单个手机弱网不应拖慢整机广播。
const SLOW_CLIENT_BYTES = 1_000_000;
let snapshotTimer: NodeJS.Timeout | undefined;
let snapshotPending = false;
// 这两个函数在加载阶段就会被 onChanged 回调触发（会话别名、watcher），
// 而 wss/快照构建在文件后面才初始化，所以定义必须提前、调用仍由
// routingReady 与快照缓存守住。
function broadcast(payload: string) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > SLOW_CLIENT_BYTES) continue;
    client.send(payload);
  }
}
function broadcastSnapshotSoon() {
  // 启动阶段（加载台账、预探测）也会触发 onChanged；此时快照构建函数
  // 尚未初始化，直接跳过，真正的首个快照由监听就绪后的广播负责。
  if (!routingReady) return;
  if (snapshotTimer) {
    snapshotPending = true;
    return;
  }
  // 落地时刻才构建：窗口内后到的变更天然包含在内，比事件携带的旧快照更新鲜。
  broadcast(JSON.stringify({ type: "snapshot", data: fullSnapshot() }));
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined;
    if (snapshotPending) {
      snapshotPending = false;
      broadcastSnapshotSoon();
    }
  }, SNAPSHOT_WINDOW_MS);
  snapshotTimer.unref();
}
const routingChanged = () => { if (routingReady) broadcastSnapshotSoon(); };
const messageDeliveries = new MessageDeliveryQueue({
  file: path.join(dataDir, "message-deliveries.json"),
  agents,
  onChanged: routingChanged,
});
await messageDeliveries.load();
const wakeOutbox = new WakeOutbox({
  file: path.join(dataDir, "wake-outbox.json"),
  resolve: (code) => threadSettings.findByWakeCode(code),
  send: async (agentId, threadId, prompt, delivery) => {
    // 主从结构后门封堵：wake 同样不得向主会话注入回合，只入缓冲等自取；
    // 落盘即视为已受理，outbox 不再重试。
    if (askService.isMaster(agentId, threadId)) {
      const buffered = await messageDeliveries.enqueue(agentId, threadId, "queue", { text: prompt },
        { id: `wake:${delivery.id}`, buffered: true });
      if (buffered.status === "failed") throw new Error(buffered.error || "唤醒消息投递失败");
      return buffered;
    }
    if (!delivery.mode) return agents.sendTurn(agentId, threadId, prompt);
    // steer 走 feedback 但不强制打断：对方运行时转向追加（codex turn/steer），
    // 空闲时直接发送；interrupt 才强制打断当前回合。
    const receipt = await messageDeliveries.enqueue(agentId, threadId,
      delivery.mode === "queue" ? "queue" : "feedback", { text: prompt },
      { id: `wake:${delivery.id}`, forceInterrupt: delivery.mode === "interrupt" });
    if (receipt.status === "failed") throw new Error(receipt.error || "唤醒消息投递失败");
    // Delivered here means durably accepted by Deck's message queue, just as a native send receipt.
    return receipt;
  },
  onChanged: routingChanged,
});
await wakeOutbox.load();
const reservedSessionAliases = () => new Set<string>([
  ...threadSettings.listSessionAliases().map((entry) => entry.alias),
  ...threadSettings.listWakeCodes().map((entry) => entry.code),
]);
/** 会话引用既可以是 ThreadSummary（`id`），也可以是已解构的 `threadId`。 */
type ThreadAliasTarget = {
  agentId?: AgentId;
  id?: string;
  threadId?: string;
};
const ensureThreadAliases = async (
  threads: Iterable<ThreadAliasTarget>,
) => {
  const targets: { agentId: AgentId; threadId: string }[] = [];
  for (const thread of threads) {
    const threadId = thread?.id || thread?.threadId;
    if (!threadId) continue;
    targets.push({ agentId: thread.agentId || "codex", threadId });
  }
  if (!targets.length) return { aliases: new Map<string, string>(), changed: false };
  const result = await threadSettings.ensureSessionAliases(targets, reservedSessionAliases());
  if (result.changed) broadcastSnapshotSoon();
  return result;
};

const askService = new AskService({
  file: path.join(dataDir, "ask-sessions.json"), agents, messages: messageDeliveries,
  reservedAliases: reservedSessionAliases,
  sessionAliases: {
    ensure: (targets) => ensureThreadAliases(targets).then(({ aliases }) => aliases),
    peek: (agentId, threadId) => threadSettings.sessionAlias(agentId, threadId),
  },
  onChanged: routingChanged,
});
await askService.load();
const askSettings = new AskSettingsStore(path.join(dataDir, "ask-settings.json"));
await askSettings.load();

const reservedAliasIdentifiers = () => {
  const reserved = new Set<string>();
  for (const item of askService.list()) {
    if (typeof item.alias === "string" && item.alias) reserved.add(item.alias);
  }
  for (const entry of threadSettings.listSessionAliases()) reserved.add(entry.alias);
  for (const entry of threadSettings.listWakeCodes()) reserved.add(entry.code);
  return reserved;
};

let sessionAliasSync: Promise<{ aliases: Map<string, string>; changed: boolean }> = Promise.resolve({
  aliases: new Map(),
  changed: false,
});
const scheduleThreadAliases = (
  threads: Iterable<ThreadAliasTarget>,
) => {
  sessionAliasSync = sessionAliasSync
    .then(() => ensureThreadAliases(threads))
    .catch((error) => {
      console.error("会话别名同步失败:", error?.message || error);
      return { aliases: new Map<string, string>(), changed: false };
    });
  return sessionAliasSync;
};

await scheduleThreadAliases(initialThreads);

  const reservedWakeAliases = () => {
    const reserved = reservedAliasIdentifiers();
    for (const entry of threadSettings.listWakeCodes()) reserved.add(entry.code);
    return reserved;
  };

async function withSessionAlias<T>(agentId: AgentId, thread: T): Promise<T> {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return thread;
  const candidate = thread as { id?: unknown; alias?: unknown };
  if (typeof candidate.id !== "string" || !candidate.id) return thread;
  const { aliases } = await ensureThreadAliases([{ agentId, id: candidate.id }]);
  const assigned = aliases.get(JSON.stringify([agentId, candidate.id]));
  const alias = assigned ?? (typeof candidate.alias === "string" ? candidate.alias : undefined);
  if (!alias || alias === candidate.alias) return thread;
  return { ...thread, alias };
}

// watcher 列表走 TTL 缓存：/proc 全量扫描不进每次快照构建，接口轮询、
// 快照与启动预热共用同一份结果；内容变化时补发快照，让首页和会话页
// 的 deck-api 状态即时更新。
// 台账记住见过的 watcher：进程消失却没留下「已唤醒/已停止」的记为失联，
// 进首页「需要处理」。Deck 停机期间消失的也能在重启后发现。
const watchDir = useWsl && wslDeckHome
  ? path.posix.join(wslDeckHome, "watch")
  : path.join(deckHome, "watch");
const watcherLedger = new WakeWatcherLedger({
  file: path.join(dataDir, "wake-watchers.json"),
  readLog: (file) =>
    (useWsl ? readWslTail(file) : readTail(file)).catch(() => undefined),
  onChanged: () => broadcastSnapshotSoon(),
});
await watcherLedger.load();
const watcherCache = new WakeWatcherCache(
  async () => {
    const items = (await listWakeWatchers(watchDir, Date.now(), { wsl: useWsl })).map(
      (watcher) => ({
        ...watcher,
        ...threadSettings.findByWakeCode(watcher.code),
      }),
    );
    // 只有完整扫描成功才对账（扫描失败会抛错，不会走到这里）。
    await watcherLedger.observe(items);
    return items;
  },
  { onChange: () => broadcastSnapshotSoon() },
);
// 没人打开页面时也要按时对账，失联不能等到下次有人看首页才发现。
setInterval(() => void watcherCache.current(), 60_000).unref();
/** 设置「关于」页用的静态信息：随快照下发，几十字节，不另开接口。 */
const serverInfo = {
  version: (() => {
    try {
      return String(
        JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"))
          .version || "",
      );
    } catch {
      return "";
    }
  })(),
  node: process.version,
  platform: process.platform,
  wsl: useWsl,
  startedAt: Date.now(),
  dataDir,
};
// Git 上下文按 cwd 缓存几秒：同一项目下的几十个会话共享一次探测，
// 快照高频构建时不会反复 fork `git`。WSL 运行时路径不属于当前进程，
// 直接标记不可用，避免对不存在/跨系统的目录执行 git。
//
// Git 上下文是「上次探测结果」，同步贴到快照上；探测本身在后台跑，不阻塞
// 快照构建。同一项目的 N 个会话共享一次探测。
const GIT_CONTEXT_TTL_MS = 3_000;
const gitContexts = new GitContextProbe({
  enabled: !useWsl,
  ttlMs: GIT_CONTEXT_TTL_MS,
});
// Deck 托管的 worktree 台账：只清理自己创建的目录（见 server/worktrees.ts）。
const worktrees = new WorktreeStore(dataDir, { enabled: !useWsl });
await worktrees.load();

/** 只读 git 调用（分支列表、worktree 清单），失败原样抛出由路由归一。 */
function runGitText(cwd: string, args: string[]): Promise<string> {
  if (useWsl) return Promise.reject(new Error("WSL 运行时不读取本机 Git 信息"));
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 4_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message || "git 命令失败").trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
const gitByCwd = new Map<string, ThreadSummary["git"]>();
const gitSeenAt = new Map<string, number>();
let gitProbeRunning = false;
let gitProbePending = false;

function scheduleGitContext(threads: ThreadSummary[]) {
  // 已有缓存且仍在 TTL 内的 cwd 不再触发探测；探针本身也带缓存，
  // 这里只是避免“每个快照都排一次队”。新增 cwd 才会真正拉起 git。
  const cwds = [...new Set(threads.map((thread) => thread.cwd).filter(Boolean))]
    .filter((cwd) => !gitByCwd.has(cwd) || Date.now() - (gitSeenAt.get(cwd) || 0) >= GIT_CONTEXT_TTL_MS);
  if (!cwds.length) return;
  if (gitProbeRunning) {
    gitProbePending = true;
    return;
  }
  gitProbeRunning = true;
  let changed = false;
  void Promise.all(
    cwds.map(async (cwd) => {
      const next = await gitContexts.probe(cwd);
      const previous = gitByCwd.get(cwd);
      if (
        !previous ||
        previous.branch !== next.branch ||
        previous.detached !== next.detached ||
        previous.linked !== next.linked ||
        previous.available !== next.available
      )
        changed = true;
      gitByCwd.set(cwd, next);
      gitSeenAt.set(cwd, Date.now());
    }),
  )
    .catch((error) => console.error("Git 上下文探测失败:", error?.message || error))
    .finally(() => {
      gitProbeRunning = false;
      if (gitProbePending) {
        gitProbePending = false;
        scheduleGitContext(threads);
        return;
      }
      // 分支没变就不推送快照：否则每个 TTL 周期都会重绘一次列表。
      if (changed) broadcastSnapshotSoon();
    });
}

const decorateGit = (thread: ThreadSummary): ThreadSummary => {
  const git = thread.cwd ? gitByCwd.get(thread.cwd) : undefined;
  return git ? { ...thread, git } : thread;
};

const snapshotWithDeferredSettings = () => {
  const snapshot = agents.snapshot();
  const display = (thread: ThreadSummary) => {
    const agentId = thread.agentId || "codex";
    const decorated = askService.decorate(threadSettings.withDeferredSettings(thread));
    const alias = threadSettings.sessionAlias(agentId, thread.id) ?? decorated.alias;
    return alias && alias !== decorated.alias ? { ...decorated, alias } : decorated;
  };
  const threads = snapshot.threads.map(display);
  const archivedThreads = snapshot.archivedThreads?.map(display);
  scheduleGitContext([...threads, ...(archivedThreads || [])]);
  return {
    ...snapshot,
    threads: threads.map(decorateGit),
    archivedThreads: archivedThreads?.map(decorateGit),
  };
};
const fullSnapshotRaw = () => ({
  ...snapshotWithDeferredSettings(),
  server: { ...serverInfo, ccSwitch: store.ccSwitchPath || null },
  activities: activity.list(),
  projects: projects.list(),
  preferences: projects.getPreferences(),
  wakeDeliveries: wakeOutbox.list(),
  messageDeliveries: messageDeliveries.list(),
  wakeCodes: threadSettings.listWakeCodes(),
  sessionAliases: threadSettings.listSessionAliases(),
  wakeWatchers: watcherCache.current(),
  wakeLost: watcherLedger.lost(),
  // 工具列表是静态的几条描述：随快照下发 + 前端缓存，工具页（桌面端是新标签页）
  // 打开即有侧栏和标题，不必再等一次 GET /tools。
  tools: tools.list(),
});
// GET /api/snapshot 是高频大对象 churn 的主要来源（glibc 的 native 堆因此
// 撑到数百 MB 不归还）。页面加载/关弹层后的动作簇只构建一次；每次变更
// 由后到的刷新或 WS 广播刷新状态，150ms 内的暂缓可以接受。
const SNAPSHOT_GET_MEMO_MS = 150;
let snapshotGetCache: { at: number; value: ReturnType<typeof fullSnapshotRaw> } | undefined;
const fullSnapshot = () => ({
  ...fullSnapshotRaw(),
});
const saveThreadSettings = async (
  id: AgentId,
  threadId: string,
  settings: Parameters<ThreadSettingsStore["defer"]>[2],
  apply: (settings: Parameters<ThreadSettingsStore["defer"]>[2]) => Promise<unknown>,
) => {
  const snapshot = agents.get(id).snapshot();
  const thread = [...snapshot.threads, ...(snapshot.archivedThreads || [])]
    .find((item) => item.id === threadId);
  if (!thread) throw new Error("会话不存在");
  if (thread.status === "running" || thread.status === "waiting" || thread.status === "starting" || threadSettings.deferred(id, threadId)) {
    await threadSettings.defer(id, threadId, settings);
    snapshotGetCache = undefined;
    if (thread.status !== "running" && thread.status !== "waiting" && thread.status !== "starting")
      await threadSettings.applyDeferred(id, threadId, apply);
    return;
  }
  await apply(settings);
  await threadSettings.update(id, threadId, settings);
  snapshotGetCache = undefined;
};
const snapshotGet = () => {
  if (snapshotGetCache && Date.now() - snapshotGetCache.at < SNAPSHOT_GET_MEMO_MS)
    return snapshotGetCache.value;
  const value = fullSnapshotRaw();
  snapshotGetCache = { at: Date.now(), value };
  return value;
};
const app = express();
// 快照/线程全文动辄数 MB，手机弱网下 gzip 是最便宜的收益：只压文本类，
// 图片走 blob/octet-stream 不会被压缩中间件重复处理。
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type") || "");
      if (
        type.startsWith("image/") ||
        type.startsWith("video/") ||
        type.startsWith("audio/") ||
        type.includes("compressed") ||
        type.includes("zip")
      )
        return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(express.json({ limit: "24mb" }));

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    platform: process.platform,
    wsl: Boolean(process.env.WSL_DISTRO_NAME),
    runtimeWsl: useWsl,
    authRequired: Boolean(token),
    pairing: Boolean(pairing),
    ccSwitch: store.ccSwitchPath || null,
  }),
);
app.post("/api/pair", (req, res) => {
  if (!pairing || !pairLimiter)
    return res.status(403).json({ error: "此服务未开启验证码配对" });
  const ip = String(req.ip || "unknown");
  if (!pairLimiter.allowed(ip))
    return res.status(429).json({ error: "尝试次数过多，请稍后再试" });
  const input = z
    .object({ code: z.string().regex(/^\d{6}$/) })
    .safeParse(req.body);
  if (!input.success)
    return res.status(400).json({ error: "验证码应为 6 位数字" });
  if (!pairing.verify(input.data.code)) {
    pairLimiter.failed(ip);
    return res.status(401).json({ error: "验证码错误" });
  }
  pairLimiter.ok(ip);
  return res.json({ token: pairing.secret });
});

const authorized = (value?: string) => {
  if (!token) return true;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
/**
 * 免 token 本地模式下 WS 握手不受 CORS 约束：浏览器里任意网页都能发起握手。
 * 此时要求 Origin 与 Host 同源（空 Origin 的非浏览器客户端放行），
 * 否则任意网站可订阅全量快照流。token 模式下 token 本身即鉴权，不额外限制。
 */
const sameOriginWs = (origin: unknown, host: unknown) => {
  if (token) return true;
  if (origin == null || origin === "") return true;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};
app.use("/api", (req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!authorized(bearer))
    return res.status(401).json({ error: "访问令牌无效" });
  next();
});

const connectionOverlaySchema = z.object({
  requestMaxRetries: z.number().int().min(0).max(100).nullable().optional(),
  streamMaxRetries: z.number().int().min(0).max(100).nullable().optional(),
  streamIdleTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .nullable()
    .optional(),
});

const route =
  (handler: (req: express.Request, res: express.Response) => Promise<any>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error: any) {
      const status = error instanceof BackgroundWorkError || typeof error?.statusCode === "number"
        ? error.statusCode : 400;
      if (!res.headersSent && !res.destroyed) res.status(status).json({ error: error.message || "请求失败" });
    }
  };
const param = (value: string | string[]) =>
  Array.isArray(value) ? value[0] : value;
// agentId 是路由与 JSON 字段里的资源标识符：小写字母数字加 -/_，
// 与 acp-agents.ts 的 descriptor id 约束一致；具体合法性由 registry.get 校验。
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const agentIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(AGENT_ID_RE, "agentId 只能包含小写字母、数字、-、_");
const agentId = (value: string | string[]) =>
  agentIdSchema.parse(param(value)) as AgentId;

app.get(
  "/api/snapshot",
  route(async () => snapshotGet()),
);
app.get(
  "/api/tasks",
  route(async () => ({
    // registry 只知道会话 updatedAt；活动追踪器记下的才是本轮真实开始时间。
    tasks: (await agents.listTasks()).map((task) => ({
      ...task,
      startedAt:
        activity.get(task.agentId, task.threadId)?.turnStartedAt ??
        task.startedAt,
    })),
  })),
);
// Coalesce tabs/clients polling together; no accumulation of identical OS probes.
let hostPending: Promise<BackgroundHostStats> | undefined;
let hostCached: { at: number; value: BackgroundHostStats } | undefined;
async function readHostStats() {
  const memory = process.memoryUsage();
  const deck = {
    pid: process.pid, rss: memory.rss, heapUsed: memory.heapUsed,
    uptimeSec: Math.round(process.uptime()), node: process.version, clients: wss.clients.size,
  };
  if (hostCached && Date.now() - hostCached.at < 1_000) return { ...hostCached.value, deck };
  hostPending ??= backgroundWork<BackgroundHostStats>("host", [wss.clients.size, agents.runtimePids(), deck])
    .then((value) => { hostCached = { at: Date.now(), value }; return value; })
    .finally(() => { hostPending = undefined; });
  return { ...await hostPending, deck };
}
app.get(
  "/api/monitor/host",
  route(async () =>
    readHostStats(),
  ),
);
// 不挂在 /api/wake 下：`watchers` 本身就是合法的唤醒代号，会与 /api/wake/:code 冲突。
// 返回缓存结果：客户端轮询顺带驱动过期重扫，变化经快照广播下发。
app.get(
  "/api/monitor/watchers",
  route(async () => ({ items: await watcherCache.ready() })),
);
const wakePrepareSchema = z.object({
  code: z.string().max(40).nullable().optional(),
  pid: z.number().int().positive().optional(),
  cwd: z.string().max(4096).optional(),
  session: z.string().max(300).optional(),
  /** session 来自 CLI 的 --session 显式参数；环境变量身份必须经进程树佐证。 */
  sessionExplicit: z.boolean().optional(),
  codexThread: z.string().max(200).optional(),
  command: z.string().max(100_000).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});
const resolveWakeCaller = async (input: z.infer<typeof wakePrepareSchema>) => resolveWakeSession({
  session: input.session || undefined, sessionExplicit: input.sessionExplicit,
  codexThread: input.codexThread || undefined,
  ancestors: input.pid ? await ancestorPids(input.pid) : [], cwd: input.cwd,
}, { threads: agents.snapshot().threads, runtimePids: agents.runtimePids(), trustEnv: useWsl });
const sessionLabel = (target: { agentId: AgentId; threadId: string }) => {
  const thread = tryThreadSummary(target.agentId, target.threadId);
  return `「${thread?.name || target.threadId}」（${target.agentId}）`;
};
app.get(["/api/deck/sessions", "/api/send/asks"], route(async () => ({ items: askService.list() })));
app.get("/api/deck/sessions/:reference/result", route(async (req) =>
  askService.readResult(param(req.params.reference)),
));
app.get("/api/deck/sessions/:reference/inspect", route(async (req) =>
  askService.inspect(param(req.params.reference), z.coerce.number().int().min(1).max(200).default(40).parse(req.query.tail)),
));
app.get(["/api/deck/agents", "/api/send/agents"], route(async () => ({
  items: agents.list().filter((agent) => agent.enabled !== false && !agent.standby).map((agent) => ({
    id: agent.id, name: agent.name, online: agent.online,
    // 调用方据此判断目标是否支持 steer（即时追加到当前回合，不打断）。
    steer: agent.capabilities.messages?.busyBehavior === "steer" &&
      agent.capabilities.messages?.deliveryModes?.includes("feedback"),
    configuration: askSettings.get(agent.id),
    profiles: agents.profiles(agent.id).map((profile) => ({ id: profile.id, name: profile.name, current: profile.current })),
  })),
})));
app.post(["/api/deck/agents/:agentId/configuration", "/api/send/agents/:agentId/configuration"], route(async (req) => {
  const id = agentId(req.params.agentId);
  return { configuration: await askSettings.set(id, askConfigurationSchema.parse(req.body)) };
}));
app.post(["/api/deck/create", "/api/send/ask"], route(async (req, res) => {
  const input = wakePrepareSchema.pick({ pid: true, cwd: true, session: true, sessionExplicit: true, codexThread: true }).extend({
    targetAgentId: agentIdSchema,
    question: z.string().trim().min(1).max(80_000),
    returnMode: z.enum(["queue", "steer", "interrupt"]).default("queue"),
    detached: z.boolean().default(false),
    providerId: z.string().max(200).optional(),
    model: z.string().max(300).optional(),
    reasoningEffort: z.string().max(100).optional(),
    configuration: askConfigurationSchema.optional(),
    name: z.string().max(200).optional(),
    /** 委派到独立的 Git worktree，避免和来源会话共用同一个 checkout。 */
    worktree: z
      .object({
        base: z.string().trim().max(240).optional(),
        name: z.string().trim().max(64).optional(),
      })
      .optional(),
  }).parse(req.body);
  const resolution = await resolveWakeCaller(input);
  if (!resolution.ok) throw new Error(`${resolution.error}；请用 --session <agentId:threadId> 显式指定发起会话`);
  const descriptor = agents.list().find((agent) => agent.id === input.targetAgentId);
  if (!descriptor?.online || descriptor.enabled === false || descriptor.standby) throw new Error("目标 agent 未上线或未启用");
  if (resolution.thread.archived) throw new Error("发起会话已归档");
  const sourceCapabilities = agents.messageState(resolution.agentId, resolution.threadId).capabilities;
  if (!input.detached && (!sourceCapabilities.messages?.deliveryModes?.includes(input.returnMode === "queue" ? "queue" : "feedback") ||
    (input.returnMode === "interrupt" && !sourceCapabilities.interrupt))) throw new Error("发起 agent 不支持所选回传方式");
  if (!input.detached && input.returnMode === "steer" && sourceCapabilities.messages?.busyBehavior !== "steer")
    throw new Error("发起会话不支持即时追加（需要 Codex 这类支持转向当前回合的会话）；空闲时用 queue 会立即发送，运行时想打断请用 interrupt");
  if (!descriptor.capabilities.messages?.deliveryModes?.includes("queue")) throw new Error("目标 agent 不支持询问消息投递");
  if (askService.decorate(resolution.thread).ask) throw new Error("询问会话不能再次发起询问，请由原会话发起，避免循环调用");
  const profiles = agents.profiles(input.targetAgentId);
  const explicit = input.providerId || input.model || input.reasoningEffort
    ? { providerId: input.providerId, model: input.model, reasoningEffort: input.reasoningEffort } : undefined;
  const configuration = resolveAskConfiguration(askSettings.get(input.targetAgentId), input.configuration ?? explicit);
  const providerId = configuration.providerId || profiles.find((profile) => profile.current)?.id ||
    (profiles.length === 1 ? profiles[0].id : undefined);
  if (configuration.providerId && !profiles.some((profile) => profile.id === configuration.providerId))
    throw new Error("目标供应商已不可用，请在 Deck 询问面板中重新设置");
  if (input.targetAgentId === "codex" && !providerId)
    throw new Error("目标没有默认供应商，请在 Deck 询问面板中手动设置默认配置");
  if (configuration.reasoningEffort) {
    const models = await agents.models(input.targetAgentId, providerId, resolution.thread.cwd);
    const model = models.find((model) => configuration.model ? model.id === configuration.model || model.model === configuration.model : model.isDefault);
    if (!model?.supportedReasoningEfforts?.some((effort) => effort.reasoningEffort === configuration.reasoningEffort))
      throw new Error("所选模型不支持该 effort，请在 Deck 询问面板中重新选择");
  }
  // 询问也可以落到独立 worktree：目标会话与来源共用 worktree 时，
  // 两边的改动会互相覆盖。失败则回滚刚建的目录，不留下空壳。
  const worktreeId = input.worktree ? randomBytes(6).toString("hex") : undefined;
  const prepared = worktreeId
    ? await worktrees.create(worktreeId, resolution.thread.cwd, input.worktree!)
    : undefined;
  let result: Awaited<ReturnType<typeof askService.create>>;
  try {
    result = await askService.create({
      sourceAgentId: resolution.agentId, sourceThreadId: resolution.threadId,
      targetAgentId: input.targetAgentId, question: input.question, returnMode: input.returnMode, detached: input.detached,
      settings: { ...configuration, cwd: prepared?.path || resolution.thread.cwd, providerId, name: input.name },
    });
  } catch (error) {
    if (worktreeId) await worktrees.remove(worktreeId, { force: true }).catch(() => undefined);
    throw error;
  }
  if (worktreeId && result.item.targetThreadId)
    await worktrees.rebind(worktreeId, result.item.targetThreadId).catch((error) =>
      console.error("询问 worktree 台账绑定失败:", error),
    );
  if (result.item.targetThreadId) {
    result.thread = await withSessionAlias(result.item.targetAgentId, result.thread);
  }
  broadcastSnapshotSoon();
  res.status(202).json(result);
}));
/** steer 要求目标能把消息转向进当前回合；不支持就明确拒绝，不静默降级为打断或排队。 */
const assertSteerTarget = (agentId: AgentId, threadId: string) => {
  let capabilities;
  try {
    capabilities = agents.messageState(agentId, threadId).capabilities;
  } catch {
    return;
  }
  if (capabilities.messages?.busyBehavior !== "steer" ||
    !capabilities.messages?.deliveryModes?.includes("feedback"))
    throw new Error("目标会话不支持即时追加（需要 Codex 这类支持转向当前回合的会话）；空闲时用 queue 会立即发送，运行时想打断请用 interrupt");
};
const assertInterruptTarget = (agentId: AgentId, threadId: string) => {
  let capabilities;
  try {
    capabilities = agents.messageState(agentId, threadId).capabilities;
  } catch {
    return;
  }
  if (!capabilities.interrupt)
    throw new Error("目标会话不支持打断当前回合；请改用 queue（空闲时立即发送）或 steer（目标支持时）");
};
/** send uses the bound source unless a destination is explicitly supplied. */
app.post("/api/deck/send", route(async (req, res) => {
  const input = wakePrepareSchema.pick({ pid: true, cwd: true, session: true, sessionExplicit: true, codexThread: true }).extend({
    text: z.string().trim().min(1).max(80_000),
    mode: z.enum(["queue", "steer", "interrupt"]).optional(),
    to: z.string().trim().min(1).max(500).optional(),
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/).optional(),
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  }).parse(req.body);
  if (input.to && input.code) throw new Error("--to 与 --code 不能同时使用");
  if (!input.to && !input.code) {
    const caller = await resolveWakeCaller(input);
    if (!caller.ok) throw new Error(`${caller.error}；请用 --session 显式指定当前发送会话，不要猜测`);
    const result = await askService.sendFrom(caller.agentId, caller.threadId, input.text, input.mode, input.requestId);
    res.status(202).json(result);
    return;
  }
  if (input.requestId) throw new Error("--request-id 仅用于默认向绑定来源发送消息");
  // 四通道收件人解析统一走 deck-recipients：错误分类与 404/409 在一处定义。
  const recipient = await resolveExplicitRecipient(input, {
    findSessionByAlias: (alias) => threadSettings.findSessionByAlias(alias),
    findAskByAlias: (alias) => askService.findByAlias(alias),
    findByWakeCode: (code) => threadSettings.findByWakeCode(code),
    isArchived: (target) => {
      try { return agents.messageState(target.agentId, target.threadId).thread.archived === true; }
      catch { return false; }
    },
    ensureAlias: async (target) =>
      (await ensureThreadAliases([target])).aliases.get(JSON.stringify([target.agentId, target.threadId])),
  });
  const target = recipient.target;
  const alias = recipient.alias;
  const kind = recipient.kind;
  // 主从结构：主会话永不接受注入。steer/interrupt 对主节点降级为缓冲，
  // 202 受理并注明，不报错，避免调用方误判失败而升级重试。
  const master = askService.isMaster(target.agentId, target.threadId);
  const mode = master ? "queue" : input.mode || "queue";
  if (!master && mode === "steer") assertSteerTarget(target.agentId, target.threadId);
  if (!master && mode === "interrupt") assertInterruptTarget(target.agentId, target.threadId);
  // send 与 wake 隔离：目标已确定，直接进入会话消息队列，不解析/创建唤醒代号。
  const id = randomBytes(8).toString("hex");
  const prompt = kind === "ask" && alias
    ? `[ask:${alias}] ${input.text}`
    : kind === "session" && alias
      ? `[send:${alias}] ${input.text}`
      : `[send:${id.slice(0, 8)}] ${input.text}`;
  const delivery = master
    ? await messageDeliveries.enqueue(target.agentId, target.threadId, "queue",
      { text: prompt }, { id: `send:${id}`, buffered: true })
    : await messageDeliveries.enqueue(
      target.agentId, target.threadId,
      mode === "queue" ? "queue" : "feedback",
      { text: prompt },
      { id: `send:${id}`, forceInterrupt: mode === "interrupt" },
    );
  res.status(202).json(master
    ? { target, alias, kind, mode, buffered: true, note: "目标为主会话，消息已入缓冲等待自取，未注入回合", delivery }
    : { target, alias, kind, mode, delivery });
}));
/**
 * deck-api wake 挂 watcher 前的确认：省略代号时识别发起命令的会话并自动分配
 * 代号（不往会话里发任何消息）；给了代号则核对它确实属于发起命令的会话；
 * 同代号同命令的 watcher 已在跑时拒绝重复挂载。dryRun 只查不改（whoami）。
 */
app.post(
  ["/api/deck/prepare", "/api/monitor/send/prepare", "/api/monitor/watchers/prepare"],
  route(async (req) => {
    const input = wakePrepareSchema.parse(req.body || {});
    const resolution = await resolveWakeCaller(input);
    let target: { agentId: AgentId; threadId: string };
    let code: string | null;
    let via: string;
    let created = false;
    if (input.code) {
      const bound = threadSettings.findByWakeCode(input.code);
      if (!bound)
        throw new Error(
          `代号 ${input.code} 不存在；省略代号即可由 Deck 识别当前会话`,
        );
      const conflict = bindingConflict(bound, resolution);
      if (conflict && !input.force) {
        const actual = Array.isArray(conflict)
          ? conflict.length
            ? `来自 ${conflict.join("/")} 的会话`
            : "无法确认来源（进程树里没有 Deck 托管的 agent，环境变量也不可信）"
          : `来自会话${sessionLabel({ agentId: (conflict.agentId || "codex") as AgentId, threadId: conflict.id })}`;
        throw new Error(
          `代号 ${input.code} 属于会话${sessionLabel(bound)}，但这条命令${actual}。省略代号即可挂到当前会话；向用户确认后加 -f 再挂到该代号`,
        );
      }
      target = bound;
      code = input.code;
      via = conflict ? "显式代号（-f 强制）" : "显式代号";
    } else {
      if (!resolution.ok) {
        const candidates = resolution.candidates
          .map((thread) => describeThread(thread))
          .join("；");
        throw new Error(
          `${resolution.error}。请向用户确认唤醒代号后用 deck-api wake <代号> … 重试${candidates ? `。候选：${candidates}` : ""}`,
        );
      }
      target = { agentId: resolution.agentId, threadId: resolution.threadId };
      via = resolution.via;
      const existing =
        threadSettings.get(target.agentId, target.threadId)?.wakeCode ?? null;
      if (input.dryRun) code = existing;
      else {
        code = await threadSettings.ensureWakeCode(
          target.agentId,
          target.threadId,
          undefined,
          reservedWakeAliases(),
        );
        created = !existing;
        if (created) broadcastSnapshotSoon();
      }
    }
    let warning: string | undefined;
    if (!input.dryRun && input.command) {
      const same = (await watcherCache.ready()).filter(
        (watcher) => watcher.command === input.command,
      );
      const duplicate = same.find((watcher) => watcher.code === code);
      if (duplicate && !input.force)
        throw new Error(
          `代号 ${code} 下已有相同命令的 watcher 在运行（pid ${duplicate.pid}），不重复挂载；确需重复请加 -f`,
        );
      const other = same.find((watcher) => watcher.code !== code);
      if (other)
        warning = `代号 ${other.code} 也在用相同命令监督（pid ${other.pid}），确认没有挂错会话`;
    }
    const summary = input.dryRun
      ? `当前会话${sessionLabel(target)}，代号 ${code ?? "尚未分配（首次挂 watcher 时自动分配）"}；依据：${via}`
      : `已绑定会话${sessionLabel(target)}，代号 ${code}${created ? "（新分配）" : ""}；依据：${via}`;
    return { code, summary, warning, ...target, via, created };
  }),
);
// 只停经扫描确认的 deck-api 进程；先记账为「主动停止」，消失时不报失联。
app.post(
  "/api/monitor/watchers/:pid/stop",
  route(async (req) => {
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid) || pid <= 1) throw new Error("无效 pid");
    watcherCache.invalidate();
    const watcher = (await watcherCache.ready()).find(
      (item) => item.pid === pid,
    );
    if (!watcher) throw new Error(`进程号 ${pid} 不是正在运行的 deck-api 监督进程`);
    // kill 前按 argv 复核一次：缓存扫描到 kill 之间进程可能退出、pid 可能
    // 被复用，SIGUSR1 的默认动作是终止，不能发给无关进程组。
    if (!(await verifyWatcherProcess(pid, { wsl: useWsl })))
      throw new Error(`进程 ${pid} 刚刚退出或已不是 deck-api watcher，取消停止`);
    watcherLedger.markStopping(watcher);
    // watcher 由 setsid 拉起，是进程组组长：连同它等待的 ssh 一起停。
    await stopWatcherProcess(pid, { wsl: useWsl });
    setTimeout(() => {
      watcherCache.invalidate();
      void watcherCache.current();
    }, 1_500).unref();
    return { ok: true };
  }),
);
// 失联 watcher：由人决定是否告诉会话（不自动注入）。
app.post(
  "/api/monitor/lost-watchers/:id/notify",
  route(async (req) => {
    const item = watcherLedger.find(param(req.params.id));
    if (!item) throw new Error("失联记录不存在");
    const target = threadSettings.findByWakeCode(item.code);
    if (!target) throw new Error(`代号 ${item.code} 已解绑，无法通知会话`);
    const prompt = [
      `[wake:${item.code}] [${item.label}] watcher 已失联：${item.reason}。`,
      `$ ${item.command}`,
      item.log ? `日志 ${item.log}` : "",
      "请检查远端任务现状，需要时重新挂 watcher。",
    ]
      .filter(Boolean)
      .join("\n");
    const delivery = await wakeOutbox.enqueue({
      code: item.code,
      prompt,
      ...target,
    });
    await watcherLedger.dismiss(item.id);
    return { delivery };
  }),
);
app.delete(
  "/api/monitor/lost-watchers/:id",
  route(async (req) => {
    await watcherLedger.dismiss(param(req.params.id));
    return { ok: true };
  }),
);
// 投递管理同样不放 /api/wake/* 下：`wake-deliveries` 是合法唤醒代号。
app.post(
  "/api/monitor/wake-deliveries/:id/retry",
  route(async (req) => ({
    item: await wakeOutbox.retry(param(req.params.id)),
  })),
);
app.delete(
  "/api/monitor/wake-deliveries/:id",
  route(async (req) => {
    await wakeOutbox.dismiss(param(req.params.id));
    return { ok: true };
  }),
);
app.post(
  "/api/session-search",
  route(async (req) => {
    const input = z
      .object({
        query: z.string().trim().min(3).max(200),
        library: z.enum(["active", "archived"]).default("active"),
        limit: z.number().int().min(1).max(50).default(30),
      })
      .parse(req.body);
    const snapshot = agents.snapshot();
    const threads =
      input.library === "archived"
        ? snapshot.archivedThreads || []
        : snapshot.threads;
    const allowed = new Set(
      threads.map((thread) => `${thread.agentId || "codex"}:${thread.id}`),
    );
    return {
      results: await sessionSearch.store.search(input.query, allowed, input.limit),
      ...await sessionSearch.progress(threads),
    };
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/background-terminals/:processId/terminate",
  route(async (req) =>
    agents.terminateBackgroundTerminal(
      agentId(req.params.agentId),
      param(req.params.threadId),
      param(req.params.processId),
    ),
  ),
);
app.get(
  "/api/tools",
  route(async () => ({ tools: tools.list() })),
);
app.post(
  "/api/tools/:toolId/run",
  route(async (req) => tools.run(param(req.params.toolId), req.body || {})),
);
app.get(
  "/api/agents/:agentId/profiles",
  route(async (req) => ({
    profiles: agents.profiles(agentId(req.params.agentId)),
  })),
);
const selectableAgent = (value: string | string[]): LocalAgent => {
  const id = agentId(value);
  if (id !== "claude" && id !== "opencode")
    throw new Error("该 Agent 不支持本机版本切换");
  return id;
};
app.get(
  "/api/agents/:agentId/bins",
  route(async (req) => {
    const id = selectableAgent(req.params.agentId);
    const envBin = id === "claude" ? process.env.CLAUDE_BIN : opencodeEnvBin;
    const selected = store.runtimeAgentBin(id);
    return {
      bins: await listLocalAgentBins(id, selected),
      selected,
      effective: envBin || selected || id,
      pinned: Boolean(envBin?.trim()),
      ...(id === "opencode" ? { activeProtocol: opencode.runtimeProtocol() } : {}),
    };
  }),
);
app.put(
  "/api/agents/:agentId/bin",
  route(async (req) => {
    const id = selectableAgent(req.params.agentId);
    const envBin = id === "claude" ? process.env.CLAUDE_BIN : opencodeEnvBin;
    if (envBin?.trim()) throw new Error(`${id.toUpperCase()}_BIN 已指定，请修改环境变量后重启 Deck`);
    const { bin } = z.object({ bin: z.string().max(1024) }).parse(req.body);
    const selected = bin.trim();
    if (selected && !await probeLocalAgentBin(selected))
      throw new Error(`该后端不可用（无法执行 ${selected} --version）`);
    const previous = store.runtimeAgentBin(id);
    const result = await agents.switchExecutable(
      id,
      async () => {
        await store.updateRuntimeAgentBin(id, selected);
        if (id === "opencode") {
          opencode.selectExecutable(selected);
        } else claude.selectExecutable(selected);
      },
      async () => {
        await store.updateRuntimeAgentBin(id, previous);
        if (id === "opencode") {
          opencode.selectExecutable(previous);
        } else claude.selectExecutable(previous);
      },
    );
    return { result, snapshot: fullSnapshot() };
  }),
);
app.get(
  "/api/agents/:agentId/models",
  route(async (req) =>
    agents.models(
      agentId(req.params.agentId),
      typeof req.query.providerId === "string"
        ? req.query.providerId
        : undefined,
      typeof req.query.directory === "string" ? req.query.directory : undefined,
    ),
  ),
);
function affinityParams(req: { query: Record<string, unknown> }) {
  const pick = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    ...(pick(req.query.providerId)
      ? { providerId: pick(req.query.providerId) }
      : {}),
    ...(pick(req.query.directory) ? { directory: pick(req.query.directory) } : {}),
  };
}
/**
 * 模型的「上次选择 / 常用 / 收藏」：收藏按 agent 全局共享（跨项目/供应商），
 * 上次选择与常用仍按 agent + 供应商/目录作用域；多端入口共享，落服务端
 * （见 model-affinity.ts）。
 */
app.get(
  "/api/agents/:agentId/model-affinity",
  route(async (req) =>
    modelAffinity.get(
      agentId(req.params.agentId),
      affinityParams(req as never),
    ),
  ),
);
const modelAffinitySchema = z.object({
  providerId: z.string().max(256).optional(),
  directory: z.string().max(1024).optional(),
  used: z.string().min(1).max(1024).optional(),
  star: z
    .object({ model: z.string().min(1).max(1024), on: z.boolean() })
    .optional(),
});
app.put(
  "/api/agents/:agentId/model-affinity",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = modelAffinitySchema.parse(req.body ?? {});
    const params = {
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    };
    if (input.star)
      return modelAffinity.setStarred(
        id,
        params,
        input.star.model,
        input.star.on,
      );
    if (input.used) return modelAffinity.recordUse(id, params, input.used);
    return modelAffinity.get(id, params);
  }),
);
/**
 * Agent 启停与重载（不重启 Deck 主服务）：
 * - PUT  /agents/:id/enabled  启用/停用；有会话在运行时返回 applied:false，
 *   带 force 才会中断它们。显式选择落盘在 agent-settings.json。
 * - POST /agents/:id/reload   重载该 agent 的配置与会话；OpenCode 默认走
 *   实例级 dispose（不打断进程），带 restart 强制重启后端进程再重读。
 * - POST /agents/reload       先按 acp-agents.json 增删改 ACP agent，再重载全部。
 */
const agentForceSchema = z.object({
  force: z.boolean().optional(),
  restart: z.boolean().optional(),
});
app.put(
  "/api/agents/:agentId/enabled",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = agentForceSchema
      .extend({ enabled: z.boolean() })
      .parse(req.body);
    const result = await agents.setEnabled(id, input.enabled, {
      force: input.force,
    });
    // 与默认一致时清掉显式选择：默认（如「命令已安装」）之后能继续跟随实际情况。
    if (result.applied)
      await agentSettings.setEnabled(
        id,
        input.enabled === agents.defaultEnabled(id) ? null : input.enabled,
      );
    return { ...result, snapshot: fullSnapshot() };
  }),
);
app.post(
  "/api/agents/reload",
  route(async (req) => {
    const input = agentForceSchema.parse(req.body ?? {});
    const sync = await acpHost.sync({ force: input.force });
    const results = await agents.reloadAll({ force: input.force });
    return { sync, results, snapshot: fullSnapshot() };
  }),
);
app.post(
  "/api/agents/:agentId/reload",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = agentForceSchema.parse(req.body ?? {});
    const result = await agents.reload(id, {
      force: input.force,
      restart: input.restart,
    });
    return { result, snapshot: fullSnapshot() };
  }),
);
/**
 * OpenCode 代理配置：读 = 全局/项目 opencode.json + server 的 GET /agent；
 * 写 = 落盘到对应 opencode.json（全局与项目同一 schema），在线时再
 * PATCH /config 让运行中的 server 立即生效。
 */
app.get(
  "/api/agents/opencode/config",
  route(async (req) => {
    const directory =
      typeof req.query.directory === "string" && req.query.directory.trim()
        ? req.query.directory.trim()
        : undefined;
    const [globalConfig, projectConfig, catalog] = await Promise.all([
      readOpenCodeConfig("global"),
      directory
        ? readOpenCodeConfig("project", directory)
        : Promise.resolve(undefined),
      opencode.isOnline()
        ? opencode.agentCatalog(directory).catch(() => [])
        : Promise.resolve([]),
    ]);
    return {
      online: opencode.isOnline(),
      global: globalConfig,
      project: projectConfig,
      agents: catalog,
    };
  }),
);
app.put(
  "/api/agents/opencode/config",
  route(async (req) => {
    const input = z
      .object({
        scope: z.enum(["global", "project"]),
        directory: z.string().min(1).optional(),
        agent: z
          .record(
            z.string(),
            z.object({
              model: z.string().nullable().optional(),
              disable: z.boolean().nullable().optional(),
              prompt: z.string().nullable().optional(),
              temperature: z.number().nullable().optional(),
            }),
          )
          .optional(),
        model: z.string().nullable().optional(),
        smallModel: z.string().nullable().optional(),
      })
      .parse(req.body);
    if (input.scope === "project" && !input.directory?.trim())
      throw new Error("项目范围必须提供 directory");
    const directory = input.directory?.trim() || undefined;
    const file = await writeOpenCodeConfig(input.scope, directory, {
      agent: input.agent,
      model: input.model,
      smallModel: input.smallModel,
    });
    // 在线时同步 PATCH 让改动立即生效；失败不影响落盘结果。
    let applied = false;
    let applyError: string | undefined;
    if (opencode.isOnline()) {
      const patch: Record<string, unknown> = {};
      if (input.agent) {
        const agents: Record<string, Record<string, unknown>> = {};
        for (const [name, entry] of Object.entries(input.agent)) {
          const cleaned: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(entry)) {
            if (value === undefined || value === null) continue;
            cleaned[key] = value;
          }
          if (entry.disable === false) cleaned.disable = false;
          if (Object.keys(cleaned).length) agents[name] = cleaned;
        }
        if (Object.keys(agents).length) patch.agent = agents;
      }
      if (input.model) patch.model = input.model;
      if (input.smallModel) patch.small_model = input.smallModel;
      if (Object.keys(patch).length) {
        try {
          await opencode.patchRuntimeConfig(patch, directory);
          applied = true;
        } catch (error: any) {
          applyError = error?.message || String(error);
        }
      }
    }
    return { path: file.path, applied, applyError };
  }),
);
/**
 * OpenCode 自定义 provider：读 = 解析全局/项目 opencode.json(c) 的
 * `provider`（V1）/`providers`（V2）段并脱敏；写 = 按文件已有格式回写。
 * provider 改动不能 PATCH 热应用，保存后需「重载 OpenCode」生效。
 */
app.get(
  "/api/agents/opencode/providers",
  route(async (req) => {
    const directory =
      typeof req.query.directory === "string" && req.query.directory.trim()
        ? req.query.directory.trim()
        : undefined;
    const [global, project] = await Promise.all([
      listOpenCodeProviders("global"),
      directory
        ? listOpenCodeProviders("project", directory)
        : Promise.resolve(undefined),
    ]);
    const online = opencode.isOnline();
    // 凭据（auth.json / 环境变量）只由 OpenCode 判断，不读取 auth.json。
    // 这里只用内存缓存秒回（`/provider` 单次 1 秒多，不能挡列表渲染），
    // 新鲜探测走下面的 /connected，前端在列表出来后再补。
    const globalConnected = online ? opencode.cachedConnectedProviders() : undefined;
    const projectConnected =
      online && directory ? opencode.cachedConnectedProviders(directory) : undefined;
    const annotate = (
      file: OpenCodeProviderFile | undefined,
      connected: Set<string> | undefined,
    ) =>
      file && connected
        ? {
            ...file,
            providers: file.providers.map((provider) => ({
              ...provider,
              connected: connected.has(provider.id),
            })),
          }
        : file;
    return {
      online,
      global: annotate(global, globalConnected),
      project: annotate(project, projectConnected),
    };
  }),
);
/**
 * 新鲜的 connected 探测：列表接口只给缓存，这里现问 serve。
 * 各自失败只落成 null（未知），不拖慢、不报错，前端徽标随后补齐。
 */
app.get(
  "/api/agents/opencode/connected",
  route(async (req) => {
    const directory =
      typeof req.query.directory === "string" && req.query.directory.trim()
        ? req.query.directory.trim()
        : undefined;
    if (!opencode.isOnline()) return { global: null, project: null };
    const [global, project] = await Promise.all([
      opencode.probeConnectedProviders(),
      directory
        ? opencode.probeConnectedProviders(directory)
        : Promise.resolve(undefined),
    ]);
    return {
      global: global ? [...global] : null,
      project: project ? [...project] : null,
    };
  }),
);
/**
 * OpenCode 工具免审规则：读 = 解析全局/项目 opencode.json(c) 的
 * `permission` 段里的纯文本规则；写 = 单条增删改，其余配置原样保留。
 * 生效同样要「重载 OpenCode」（全局配置按进程生命周期缓存）。
 */
app.get(
  "/api/agents/opencode/permissions",
  route(async (req) => {
    const directory =
      typeof req.query.directory === "string" && req.query.directory.trim()
        ? req.query.directory.trim()
        : undefined;
    const [global, project] = await Promise.all([
      readOpenCodePermissions("global"),
      directory
        ? readOpenCodePermissions("project", directory)
        : Promise.resolve(undefined),
    ]);
    return { online: opencode.isOnline(), global, project };
  }),
);
app.put(
  "/api/agents/opencode/permissions",
  route(async (req) => {
    const input = z
      .object({
        scope: z.enum(["global", "project"]),
        directory: z.string().min(1).optional(),
        tool: z.string().min(1).max(100),
        rule: z.enum(["ask", "allow", "deny"]).nullable().optional(),
      })
      .parse(req.body);
    if (input.scope === "project" && !input.directory?.trim())
      throw new Error("项目范围必须提供 directory");
    const file = await writeOpenCodePermission(
      input.scope,
      input.directory?.trim() || undefined,
      input.tool,
      input.rule ?? null,
    );
    return { path: file.path, rules: file.rules, needsReload: true };
  }),
);
app.post(
  "/api/agents/opencode/providers",
  route(async (req) => {
    const input = z
      .object({
        scope: z.enum(["global", "project"]),
        directory: z.string().min(1).optional(),
        id: z.string().min(1).max(64),
        name: z.string().max(120).optional(),
        npm: z.string().max(120).optional(),
        baseURL: z.string().min(1).max(500),
        apiKey: z.string().max(2000).optional(),
        models: z
          .array(
            z.union([
              z.string().min(1).max(200),
              z.object({
                id: z.string().min(1).max(200),
                name: z.string().max(200).optional(),
                variants: z.array(z.string().min(1).max(100)).max(50).optional(),
                supportsImages: z.boolean().optional(),
                sdk: z.string().max(120).optional(),
              }),
            ]),
          )
          .min(1)
          .max(100),
      })
      .parse(req.body);
    if (input.scope === "project" && !input.directory?.trim())
      throw new Error("项目范围必须提供 directory");
    const file = await upsertOpenCodeProvider(
      input.scope,
      input.directory?.trim() || undefined,
      {
        id: input.id,
        name: input.name,
        npm: input.npm,
        baseURL: input.baseURL,
        apiKey: input.apiKey,
        models: input.models,
      },
    );
    return { path: file.path, providers: file.providers, needsReload: true };
  }),
);
app.delete(
  "/api/agents/opencode/providers/:id",
  route(async (req) => {
    const scope = z.enum(["global", "project"]).parse(req.query.scope);
    const directory =
      typeof req.query.directory === "string" && req.query.directory.trim()
        ? req.query.directory.trim()
        : undefined;
    if (scope === "project" && !directory)
      throw new Error("项目范围必须提供 directory");
    const file = await deleteOpenCodeProvider(
      scope,
      directory,
      param(req.params.id),
    );
    return { path: file.path, providers: file.providers, needsReload: true };
  }),
);
app.post(
  "/api/agents/:agentId/threads",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = z
      .object({
        providerId: z.string().optional(),
        cwd: z.string().min(1),
        name: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        personality: z.enum(["friendly", "pragmatic", "none"]).optional(),
        approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
        approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
        permissionMode: z
          .enum([
            "default",
            "acceptEdits",
            "plan",
            "dontAsk",
            "bypassPermissions",
          ])
          .optional(),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
        sessionMode: z.string().max(100).optional(),
        /** 在 Deck 托管的独立 worktree 中创建会话；cwd 指向该目录。 */
        worktree: z
          .object({
            /** 基准分支或提交；缺省用当前 HEAD。 */
            base: z.string().trim().max(240).optional(),
            /** worktree 目录名；缺省用会话 id。 */
            name: z.string().trim().max(64).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    if (id === "codex" && !input.providerId)
      throw new Error("Codex 会话必须指定供应商");
    let thread: ThreadSummary;
    if (input.worktree) {
      // 先建 worktree 再建会话：会话创建失败时把刚建的 worktree 收掉，
      // 成功则把台账从临时 id 改挂到真实会话 id（删除会话时据此清理）。
      const temporaryId = randomBytes(6).toString("hex");
      const prepared = await worktrees.create(temporaryId, input.cwd, input.worktree);
      try {
        thread = (await agents.createThread(id, { ...input, cwd: prepared.path })) as ThreadSummary;
        await worktrees.rebind(temporaryId, thread.id);
      } catch (error) {
        await worktrees.remove(temporaryId, { force: true }).catch(() => undefined);
        throw error;
      }
    } else {
      thread = (await agents.createThread(id, input)) as ThreadSummary;
    }
    thread = await withSessionAlias(id, thread);
    await projects.rememberCreate({
      agentId: id,
      // 记住 worktree 所在目录，下次新建时能直接选到它。
      cwd: thread.cwd || input.cwd,
      providerId: input.providerId || `${id}-current`,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
      approvalsReviewer: input.approvalsReviewer,
      permissionMode: input.permissionMode,
    });
    return thread;
  }),
);
/**
 * 长会话分页：`?turnLimit=N` 只下发最新 N 轮（`?beforeTurn=id` 则取该轮之前
 * 的 N 轮），省首屏渲染；不传即全文（旧行为）。搜索索引吃的是切片前的全量。
 * 被截掉的老轮数记在 PARTIAL_KEY 上，前端据此展示“加载更早”。
 */
app.get(
  "/api/agents/:agentId/threads/:threadId",
  route(async (req, res) => {
    const startedAt = performance.now();
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    const limit = Number(req.query.turnLimit);
    const full = await agents.readThread(id, threadId, {
      turnLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
      beforeTurn: typeof req.query.beforeTurn === "string" ? req.query.beforeTurn : undefined,
    });
    const readAt = performance.now();
    const snapshot = agents.get(id).snapshot();
    const thread = [
      ...snapshot.threads,
      ...(snapshot.archivedThreads || []),
    ].find((item) => item.id === threadId);
    if (thread && !(full as any)?.[TURN_SLICE_PARTIAL_KEY]) sessionSearch.capture(thread, full);
    // 搜索索引吃全量；仅处理当前页，避免整段旧历史拖慢首屏。
    const body = prepareThreadResponse(full, req.query, thread?.activeTurnId);
    res.setHeader(
      "Server-Timing",
      `thread-read;dur=${(readAt - startedAt).toFixed(1)}, thread-prepare;dur=${(performance.now() - readAt).toFixed(1)}`,
    );
    return body;
  }),
);
app.get(
  "/api/agents/:agentId/threads/:threadId/turns/:turnId",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    return agents.readTurn(
      id,
      param(req.params.threadId),
      param(req.params.turnId),
    );
  }),
);
app.get(
  "/api/agents/:agentId/threads/:threadId/image",
  route(async (req, res) => {
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    const requestedPath = String(req.query.path || "");
    const snapshot = agents.get(id).snapshot();
    const thread = [
      ...snapshot.threads,
      ...(snapshot.archivedThreads || []),
    ].find((item) => item.id === threadId);
    if (!thread?.cwd) throw new Error("会话不存在或没有工作目录");
    const imagePath = await resolveThreadImage(thread.cwd, requestedPath, async () =>
      referencedThreadImages(await agents.readThread(id, threadId, { background: true })),
    );
    await new Promise<void>((resolve, reject) => {
      res.sendFile(imagePath, (error) => (error ? reject(error) : resolve()));
    });
  }),
);
app.patch(
  "/api/agents/:agentId/threads/:threadId",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    const input = z
      .object({
        name: z.string().min(1).optional(),
        settings: z
          .object({
            providerId: z.string().min(1).optional(),
            model: z.string().optional(),
            reasoningEffort: z.string().optional(),
            personality: z.enum(["friendly", "pragmatic", "none"]).optional(),
            approvalPolicy: z
              .enum(["untrusted", "on-request", "never"])
              .optional(),
            approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional(),
            serviceTier: z.string().min(1).nullable().optional(),
            permissionMode: z
              .enum([
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "bypassPermissions",
              ])
              .optional(),
            sessionMode: z.string().max(100).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    if (id !== "claude" && input.settings?.providerId)
      throw new Error("Codex 供应商切换必须使用会话迁移接口");
    if (input.name) await agents.renameThread(id, threadId, input.name);
    if (input.settings) {
      await saveThreadSettings(id, threadId, input.settings, (settings) =>
        agents.updateThreadSettings(id, threadId, settings),
      );
      if (input.settings.providerId && !threadSettings.deferred(id, threadId)) {
        const snapshot = agents.get(id).snapshot();
        const thread = [
          ...snapshot.threads,
          ...(snapshot.archivedThreads || []),
        ].find((item) => item.id === threadId);
        if (thread)
          await projects.rememberCreate({
            agentId: id,
            cwd: thread.cwd,
            providerId: thread.providerId,
            model: thread.model,
            permissionMode: thread.permissionMode,
          });
      }
    }
    return fullSnapshot();
  }),
);
app.delete(
  "/api/agents/:agentId/threads/:threadId",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    const options = z
      .object({ closeConnection: z.boolean().optional() })
      .parse(req.body || {});
    await agents.deleteThread(id, threadId, options);
    await threadSettings.remove(id, threadId);
    // 只清理 Deck 自己创建、且没有未提交内容的 worktree；
    // 用户手动创建的目录和还有改动的目录一律保留。
    let worktree: Awaited<ReturnType<typeof worktrees.remove>> | undefined;
    try {
      worktree = await worktrees.remove(threadId);
    } catch (error: any) {
      console.error("清理 worktree 失败:", error?.message || error);
    }
    if (req.query.ack === "1") return { ok: true, agentId: id, threadId, worktree };
    return fullSnapshot();
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/archive",
  route(async (req) => {
    await agents.archiveThread(
      agentId(req.params.agentId),
      param(req.params.threadId),
    );
    return fullSnapshot();
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/unarchive",
  route(async (req) => {
    await agents.unarchiveThread(
      agentId(req.params.agentId),
      param(req.params.threadId),
    );
    return fullSnapshot();
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/turns",
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
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    // 主从搭车：主会话缓冲区的 agent 消息不抢占回合，只在用户下一次输入时
    // 把摘要拼进本轮上下文并原子领取；发送失败则缓冲原样保留，下次再搭车。
    const buffered = askService.isMaster(id, threadId) ? messageDeliveries.inbox(id, threadId) : [];
    if (buffered.length && (input.text.trim() || input.images?.length)) {
      const digest = buffered.slice(0, 5).map((item, index) =>
        `${index + 1}. ${(item.text || item.preview || "").trim().slice(0, 200)}`).join("\n");
      const text = `【deck-api 缓冲 ${buffered.length} 条，未注入回合，已随本轮输入搭车，请一并处理】\n${digest}\n---\n${input.text}`;
      const receipt = await agents.sendTurn(id, threadId, text, input.images);
      await messageDeliveries.claim(id, threadId);
      return receipt;
    }
    return agents.sendTurn(id, threadId, input.text, input.images);
  }),
);
registerMessageRoutes(app, agents, messageDeliveries);
if (installDevApi(app, agents))
  process.stderr.write("开发测试 API 已启用：/api/dev/approvals\n");
app.post(
  "/api/agents/:agentId/threads/:threadId/interrupt",
  route(async (req) => {
    const { turnId } = z.object({ turnId: z.string() }).parse(req.body);
    return agents.interrupt(
      agentId(req.params.agentId),
      param(req.params.threadId),
      turnId,
    );
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/force-stop",
  route(async (req) => {
    const result = (await agents.forceStop(
      agentId(req.params.agentId),
      param(req.params.threadId),
    )) as Record<string, unknown>;
    return { ...result, snapshot: fullSnapshot() };
  }),
);
const findThreadSummary = (id: AgentId, threadId: string) => {
  const snapshot = agents.get(id).snapshot();
  return [...snapshot.threads, ...(snapshot.archivedThreads || [])].find(
    (item) => item.id === threadId,
  );
};
// adapter 已被移除时代号本体仍要返回，便于排查悬挂映射。
const tryThreadSummary = (id: AgentId, threadId: string) => {
  try {
    return findThreadSummary(id, threadId);
  } catch {
    return undefined;
  }
};
// watcher 通常就跑在 deck 本机（agent 的 bash 亦然），回环直连
// 即可，无需绕公网/tunnel。
const localBase = `http://${formatHost(
  host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host,
)}:${port}`;
app.get(
  "/api/agents/:agentId/threads/:threadId/wake",
  route(async (req) => {
    const code =
      threadSettings.get(
        agentId(req.params.agentId),
        param(req.params.threadId),
      )?.wakeCode ?? null;
    return { code, localUrl: code ? `${localBase}/api/deck/events/${code}` : null };
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/wake",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const threadId = param(req.params.threadId);
    if (!findThreadSummary(id, threadId)) throw new Error("会话不存在");
    const { code, notify } = z
      .object({
        code: z.string().max(40).optional(),
        notify: z.boolean().optional(),
      })
      .parse(req.body || {});
    const wakeCode = await threadSettings.ensureWakeCode(id, threadId, code, reservedWakeAliases());
    broadcastSnapshotSoon();
    const wakePath = `/api/deck/events/${wakeCode}`;
    const localUrl = `${localBase}${wakePath}`;
    const result: {
      code: string;
      path: string;
      localUrl: string;
      notified?: boolean;
    } = { code: wakeCode, path: wakePath, localUrl };
    if (notify) {
      // 只告诉会话代号与用法；地址和令牌由本机发现文件提供，
      // 令牌不进入会话上下文。
      try {
        await agents.sendTurn(
          id,
          threadId,
          [
            `[deck] 本会话已开启远程唤醒，代号 ${wakeCode}。`,
            `在远端启动长任务后，用 deck-api skill 在本机挂 watcher；任务结束时我会收到 [wake:${wakeCode}] 消息。挂好后直接结束当前回合，不要阻塞等待或自己轮询。`,
            `没有该 skill 时可直接调用：curl -X POST "$(cat ${deckHome}/url)${wakePath}" -H "Authorization: Bearer $(cat ${deckHome}/token)" -H "Content-Type: application/json" -d '{"text":"<事件摘要>"}'`,
            "本条仅需确认收到，无需其它操作。",
          ].join("\n"),
        );
        result.notified = true;
      } catch (error: any) {
        // 通知失败不影响代号生效（例如会话正忙、进程未起），UI 另行提示。
        result.notified = false;
      }
    }
    return result;
  }),
);
app.delete(
  "/api/agents/:agentId/threads/:threadId/wake",
  route(async (req) => {
    await threadSettings.clearWakeCode(
      agentId(req.params.agentId),
      param(req.params.threadId),
    );
    broadcastSnapshotSoon();
    return { ok: true };
  }),
);
app.get(
  ["/api/deck/targets", "/api/send/targets", "/api/wake"],
  route(async () => ({
    items: threadSettings.listWakeCodes().map((target) => {
      const thread = tryThreadSummary(target.agentId, target.threadId);
      return {
        ...target,
        name: thread?.name,
        cwd: thread?.cwd,
        status: thread?.status,
      };
    }),
  })),
);
app.get(
  ["/api/deck/events/:code", "/api/send/events/:code", "/api/wake/:code"],
  route(async (req) => {
    const code = param(req.params.code);
    const target = threadSettings.findByWakeCode(code);
    if (!target) throw new Error(`wake code ${code} 不存在`);
    const thread = tryThreadSummary(target.agentId, target.threadId);
    return { code, ...target, name: thread?.name, status: thread?.status };
  }),
);
app.post(
  ["/api/deck/events/:code", "/api/send/events/:code", "/api/wake/:code"],
  route(async (req, res) => {
    const code = param(req.params.code);
    const target = threadSettings.findByWakeCode(code);
    if (!target) throw new Error(`wake code ${code} 不存在`);
    const body = (
      req.body && typeof req.body === "object" ? req.body : {}
    ) as Record<string, unknown>;
    const { text, mode: rawMode, ...rest } = body;
    const mode = rawMode === undefined ? undefined : z.enum(["queue", "steer", "interrupt"]).parse(rawMode);
    if (mode === "steer") assertSteerTarget(target.agentId, target.threadId);
    const trimmed = typeof text === "string" ? text.trim() : "";
    const detail =
      trimmed || (Object.keys(rest).length ? JSON.stringify(rest) : "");
    const prompt = detail
      ? `[wake:${code}] ${detail}`
      : `[wake:${code}] 外部唤醒信号`;
    if (prompt.length > 100_000) throw new Error("wake 载荷过大");
    // 先落盘再应答：脚本只认 2xx，投递由 wakeOutbox 在后台重试到送达。
    // 此刻进程崩了，重启后队列也会接着投。
    const delivery = await wakeOutbox.enqueue({ code, prompt, mode, ...target });
    res.status(202).json({ code, ...target, delivery });
  }),
);
app.get(
  "/api/agents/:agentId/threads/:threadId/commands",
  route(async (req) => ({
    commands: await agents.listSessionCommands(
      agentId(req.params.agentId),
      param(req.params.threadId),
    ),
  })),
);
app.get(
  "/api/agents/:agentId/threads/:threadId/skills",
  route(async (req) =>
    agents.listSkills(
      agentId(req.params.agentId),
      param(req.params.threadId),
      req.query.reload === "1",
    ),
  ),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/commands",
  route(async (req) => {
    const input = z
      .object({
        command: z.string().min(1).max(120),
        arguments: z.string().max(10_000).optional().default(""),
      })
      .parse(req.body || {});
    return agents.runSessionCommand(
      agentId(req.params.agentId),
      param(req.params.threadId),
      input.command,
      input.arguments,
    );
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/compact",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    if (id !== "opencode") throw new Error("该 Agent 暂不支持压缩上下文");
    return agents.compactSession(id, param(req.params.threadId));
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/revert",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    if (id !== "opencode" && id !== "codex")
      throw new Error("该 Agent 暂不支持撤回消息");
    const input = z
      .object({ messageID: z.string().min(1).max(200).optional() })
      .parse(req.body || {});
    return agents.revertSession(
      id,
      param(req.params.threadId),
      input.messageID,
    );
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/unrevert",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    if (id !== "opencode") throw new Error("该 Agent 暂不支持恢复撤回");
    return agents.unrevertSession(id, param(req.params.threadId));
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/fork",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = z
      .object({
        messageID: z.string().min(1).max(200).optional(),
        lastTurnId: z.string().min(1).max(200).optional(),
      })
      .parse(req.body || {});
    return withSessionAlias(id, await agents.forkThread(id, param(req.params.threadId), input));
  }),
);
app.post(
  "/api/agents/:agentId/threads/:threadId/retry",
  route(async (req) => {
    const id = agentId(req.params.agentId);
    const input = z
      .object({
        turnId: z.string().min(1).max(200),
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
    return withSessionAlias(id, await agents.retryFromTurn(
      id,
      param(req.params.threadId),
      input.turnId,
      input.text,
      input.images,
    ));
  }),
);
app.post(
  "/api/agents/:agentId/approvals/:approvalId",
  route(async (req) => {
    const input = z
      .object({
        decision: z
          .enum(["accept", "acceptForSession", "allowForProject", "decline", "cancel"])
          .optional(),
        optionId: z.string().optional(),
        permissions: z.unknown().optional(),
        scope: z.enum(["session", "turn"]).optional(),
        answers: z.unknown().optional(),
      })
      .parse(req.body);
    return agents.resolveApproval(
      agentId(req.params.agentId),
      param(req.params.approvalId),
      input,
    );
  }),
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
    await claude.reloadProfiles();
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
app.put(
  "/api/runtime/model-context",  route(async (req) => {
    const value = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    const input = z
      .object({
        modelContextWindow: value.nullable().optional(),
        modelAutoCompactTokenLimit: value.nullable().optional(),
      })
      .parse(req.body);
    if (
      input.modelContextWindow != null &&
      input.modelAutoCompactTokenLimit != null &&
      input.modelAutoCompactTokenLimit >= input.modelContextWindow
    )
      throw new Error("自动压缩阈值必须小于最大上下文");
    await manager.updateRuntimeModelConfig({
      modelContextWindow: input.modelContextWindow ?? undefined,
      modelAutoCompactTokenLimit: input.modelAutoCompactTokenLimit ?? undefined,
    });
    return fullSnapshot();
  }),
);
app.get(
  "/api/runtime/codex-bins",
  route(async () => {
    const { listCodexBinCandidates } = await import("./codex-bins.js");
    const bins = await listCodexBinCandidates(
      process.env,
      useWsl,
      store.runtimeCodexBin?.() || "",
    );
    return {
      bins,
      selected: store.runtimeCodexBin?.() || "",
      effective: manager.runtimeStatus().codexBin || "codex",
      pinned: Boolean(
        (useWsl ? process.env.CODEX_WSL_BIN : process.env.CODEX_BIN)?.trim(),
      ),
    };
  }),
);
app.put(
  "/api/runtime/codex-bin",
  route(async (req) => {
    const input = z.object({ bin: z.string().max(1024) }).parse(req.body);
    const bin = (input.bin || "").trim();
    if (bin) {
      const { probeCodexVersion } = await import("./codex-bins.js");
      const version = await probeCodexVersion(bin);
      if (!version) throw new Error(`该后端不可用（无法执行 ${bin} --version）`);
    }
    await manager.updateRuntimeCodexBin(bin);
    return fullSnapshot();
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
            agentId: agentIdSchema.optional(),
            providerId: z.string().optional(),
            model: z.string().optional(),
            reasoningEffort: z.string().optional(),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional(),
            approvalPolicy: z
              .enum(["untrusted", "on-request", "never"])
              .optional(),
            approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
            permissionMode: z
              .enum([
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "bypassPermissions",
              ])
              .optional(),
          })
          .merge(connectionOverlaySchema)
          .optional(),
      })
      .parse(req.body);
    const previous =
      input.key || input.cwd
        ? projects.get(input.key || input.cwd || "")
        : undefined;
    await projects.upsert(input);
    let connectionApplied = false;
    let connectionPending = false;
    if (
      input.defaults &&
      !sameConnectionOverlay(previous?.defaults, input.defaults)
    ) {
      await projects.setConnectionOverlay(
        pickConnectionOverlay(input.defaults),
      );
      if (manager.busyThreads().length === 0) {
        await manager.applyProviderConfig();
        connectionApplied = true;
      } else {
        connectionPending = true;
      }
    }
    return { ...fullSnapshot(), connectionApplied, connectionPending };
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
        lastAgentId: agentIdSchema.optional(),
        lastProviderId: z.string().optional(),
        lastModel: z.string().optional(),
        lastReasoningEffort: z.string().optional(),
        lastSandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
        lastApprovalPolicy: z
          .enum(["untrusted", "on-request", "never"])
          .optional(),
        lastApprovalsReviewer: z.enum(["user", "auto_review"]).optional(),
        lastPermissionMode: z
          .enum([
            "default",
            "acceptEdits",
            "plan",
            "dontAsk",
            "bypassPermissions",
          ])
          .optional(),
        pinDefaults: z.boolean().optional(),
        recentDirs: z.array(z.string()).optional(),
      })
      .merge(connectionOverlaySchema)
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
      { useWsl },
    ),
  ),
);
/**
 * 新建会话时选择 Git 基准：返回仓库状态、已有分支和 worktree 选项。
 * 只读，不创建任何东西；没有 git 时返回 repository:false。
 */
app.get(
  "/api/deck/git",
  route(async (req) => {
    const cwd = z.string().trim().min(1).max(4_096).parse(req.query.cwd);
    const context = await gitContexts.probe(cwd);
    if (!context.available)
      return { context, branches: [], worktrees: [], root: undefined };
    const root = context.root || cwd;
    const [branchList, current, list] = await Promise.all([
      runGitText(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      runGitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGitText(root, ["worktree", "list", "--porcelain"]),
    ]);
    return {
      context,
      root,
      branch: current.trim() || undefined,
      branches: branchList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
      worktrees: parseWorktreePorcelain(list)
        .filter((entry) => entry.path)
        .map((entry) => ({
          path: entry.path,
          branch: entry.branch,
          detached: entry.detached,
          managed: Boolean(worktrees.list().find((item) => item.path === entry.path)),
        })),
    };
  }),
);
/**
 * 单独移除某个会话独占的 worktree（会话仍保留时也可用）。
 * 默认拒绝删除有未提交改动的目录，必须显式 force 才会丢弃。
 */
app.delete(
  "/api/agents/:agentId/threads/:threadId/worktree",
  route(async (req) => {
    const threadId = param(req.params.threadId);
    const force = z
      .object({ force: z.boolean().optional() })
      .parse(req.body || {}).force === true;
    return worktrees.remove(threadId, { force });
  }),
);

app.get(
  "/api/providers/:id/models",
  route(async (req) => manager.listModels(param(req.params.id))),
);
app.post(
  "/api/claude/providers",
  route(async (req) => {
    await claudeProviders.upsert(claudeProviderInput.parse(req.body));
    await claude.reloadProfiles();
    return fullSnapshot();
  }),
);
app.delete(
  "/api/claude/providers/:id",
  route(async (req) => {
    await claudeProviders.remove(param(req.params.id));
    await claude.reloadProfiles();
    return fullSnapshot();
  }),
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
    await agents.refreshAll();
    return fullSnapshot();
  }),
);
app.post(
  "/api/agents/codex/history/repair",
  route(async () => {
    await agents.repairHistory("codex");
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
        approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional(),
      })
      .parse(req.body);
    const thread = await withSessionAlias("codex", await manager.createThread(input.providerId, input));
    await projects.rememberCreate({
      agentId: "codex",
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
  route(async (req, res) => {
    const startedAt = performance.now();
    const threadId = param(req.params.threadId);
    const full = await manager.readThread(
      param(req.params.providerId),
      threadId,
    );
    const readAt = performance.now();
    const snapshot = manager.snapshot();
    const thread = [...snapshot.threads, ...(snapshot.archivedThreads || [])]
      .find((item) => item.id === threadId);
    if (thread) sessionSearch.capture(thread, full);
    const body = prepareThreadResponse(full, req.query, thread?.activeTurnId);
    res.setHeader(
      "Server-Timing",
      `thread-read;dur=${(readAt - startedAt).toFixed(1)}, thread-prepare;dur=${(performance.now() - readAt).toFixed(1)}`,
    );
    return body;
  }),
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
app.post(
  "/api/threads/:providerId/:threadId/force-stop",
  route(async (req) => {
    const result = (await manager.forceStop(
      param(req.params.providerId),
      param(req.params.threadId),
    )) as Record<string, unknown>;
    return { ...result, snapshot: fullSnapshot() };
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
            approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional(),
            serviceTier: z.string().min(1).nullable().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    if (input.name)
      await manager.renameThread(providerId, threadId, input.name);
    if (input.settings) {
      await saveThreadSettings("codex", threadId, input.settings, (settings) =>
        manager.updateThreadSettings(providerId, threadId, settings),
      );
    }
    return fullSnapshot();
  }),
);
app.get(
  "/api/threads/:providerId/:threadId/skills",
  route(async (req) =>
    manager.listSkills(
      param(req.params.providerId),
      param(req.params.threadId),
      req.query.reload === "1",
    ),
  ),
);
app.get(
  "/api/threads/:providerId/:threadId/mcp",
  route(async (req) =>
    manager.listMcpServers(
      param(req.params.providerId),
      param(req.params.threadId),
      req.query.verbose === "1",
    ),
  ),
);
app.get(
  "/api/threads/:providerId/:threadId/files",
  route(async (req) => {
    const query = z.string().max(500).optional().default("").parse(req.query.q);
    return manager.searchWorkspaceFiles(
      param(req.params.providerId),
      param(req.params.threadId),
      query,
    );
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/fork",
  route(async (req) => {
    const input = z
      .object({ lastTurnId: z.string().optional() })
      .parse(req.body || {});
    return withSessionAlias("codex", await manager.forkThread(
      param(req.params.providerId),
      param(req.params.threadId),
      input,
    ));
  }),
);
app.post(
  "/api/threads/:providerId/:threadId/retry",
  route(async (req) => {
    const input = z
      .object({
        turnId: z.string().min(1),
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
    return withSessionAlias("codex", await manager.retryFromTurn(
      param(req.params.providerId),
      param(req.params.threadId),
      input.turnId,
      input.text,
      input.images,
    ));
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
    manager.showDiff(param(req.params.providerId), param(req.params.threadId)),
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
      agentId: "codex",
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
    const threadId = param(req.params.threadId);
    await manager.deleteThread(param(req.params.providerId), threadId);
    await threadSettings.remove("codex", threadId);
    return fullSnapshot();
  }),
);
app.post(
  "/api/approvals/:id",
  route(async (req) => {
    const input = z
      .object({
        decision: z
          .enum(["accept", "acceptForSession", "allowForProject", "decline", "cancel"])
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
  route(async (req) => manager.loadOfficialUsage(Boolean(req.query?.force))),
);

// 短别名只做导航重定向：消息正文里不再携带完整会话 key。
app.get("/s/:alias", (req, res) => {
  const reference = param(req.params.alias);
  if (reference.startsWith("s-")) {
    const found = threadSettings.findSessionByAlias(reference);
    if (!found) {
      res.status(404).send("会话别名不存在");
      return;
    }
    let providerId: string;
    try {
      providerId = agents.messageState(found.agentId, found.threadId).thread.providerId;
    } catch {
      res.status(404).send("会话不存在或尚未创建完成");
      return;
    }
    const key = `${found.agentId}:${providerId}:${found.threadId}`;
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, `/session/${encodeURIComponent(key)}`);
    return;
  }
  const found = askService.findByAlias(reference);
  if (!found?.item.targetThreadId) {
    res.status(404).send("会话不存在或尚未创建完成");
    return;
  }
  const key = `${found.item.targetAgentId}:${found.item.targetProviderId || ""}:${found.item.targetThreadId}`;
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, `/session/${encodeURIComponent(key)}`);
});

const webDir = path.join(projectRoot, "dist-web");
// vite 产物文件名自带 hash：长缓存一年 + immutable，二次打开只下 index.html。
// index.html 本身走 no-store，保证发版后客户端立刻拿到新资源引用。
app.use(
  express.static(webDir, {
    maxAge: "365d",
    immutable: true,
    index: false,
  }),
);
app.get("/{*path}", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(webDir, "index.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  // 流式 delta 高频小包，permessage-deflate 省手机流量；服务端内存换带宽值得。
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 8 },
    threshold: 512,
  },
});
const toolWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  // Host / URL / 路径解码全由客户端控制，任何一步抛异常都只能断开这条连接，
  // 绝不能让异常逃出 listener 崩掉整个进程（此前为免鉴权远程 DoS）。
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || ""}`);
    if (!authorized(url.searchParams.get("token") || undefined))
      return socket.destroy();
    if (!sameOriginWs(req.headers.origin, req.headers.host))
      return socket.destroy();
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
      return;
    }
    const match = url.pathname.match(/^\/ws\/tools\/([^/]+)$/);
    if (!match) return socket.destroy();
    let toolId: string;
    try {
      toolId = decodeURIComponent(match[1]);
    } catch {
      return socket.destroy();
    }
    toolWss.handleUpgrade(req, socket, head, (ws) => {
      try {
        tools.connect(toolId, ws);
      } catch (error: any) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: error?.message || "工具连接失败",
          }),
        );
        ws.close(1008, "tool unavailable");
      }
    });
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
});
wss.on("connection", (ws) =>
  ws.send(JSON.stringify({ type: "snapshot", data: fullSnapshot() })),
);
// 全量快照一次构建 + 序列化在 threads 上百时可达数十毫秒，而 snapshot 事件
// 在刷新/批量操作时会连发。50ms 合并窗口内只保留最新一次，中间态直接跳过
// （快照幂等，只关心最终态），上限 20 次/秒。
// 慢客户端积压超过该阈值即跳过本次推送：单个手机弱网不应拖慢整机广播。
routingReady = true;
agents.on("event", (event) => {
  if (event.type === "runtime.process") {
    // 关机流程中子进程退出事件不得重建已被清除的锁文件。
    if (shuttingDown) return;
    updateRuntimeLock(dataDir, {
      childPid: event.data?.pid,
      listen: event.data?.remoteUrl,
      ...(event.data?.codexBin ? { codexBin: event.data.codexBin } : {}),
    });
    // 版本探测后补进锁：只做展示与 mismatch 提示，不做任何自动清理。
    if (event.data?.codexBin) {
      void import("./codex-bins.js").then(({ probeCodexVersion }) =>
        probeCodexVersion(event.data.codexBin).then((version) => {
          if (version && !shuttingDown)
            updateRuntimeLock(dataDir, { codexVersion: version });
        }),
      );
    }
    return;
  }
  const activityUpdate = activity.ingest(event);
  if (activityUpdate)
    broadcast(
      JSON.stringify({ type: "activity.updated", data: activityUpdate }),
    );
  if (
    event.type === "snapshot" ||
    event.type === "thread.updated" ||
    event.type === "thread.deleted"
  ) {
    // 落盘的是 cacheSnapshot：已停用 agent 的会话摘要也要保留，重新启用前不能丢。
    const cache = agents.cacheSnapshot();
    const historiesReady = agents
      .list()
      .every(
        (agent) => agent.enabled === false || agent.historyStatus === "ready",
      );
    if (cache.threads.length || cache.archivedThreads.length || historiesReady)
      threadSummaries.schedule(cache.threads, cache.archivedThreads);
    void scheduleThreadAliases([...cache.threads, ...(cache.archivedThreads || [])]);
    sessionSearch.reconcileSoon();
  }
  // snapshot 走合并窗口；thread.updated/deleted 与 codex.event 本就是增量小包，
  // 直接透传，不进快照合并通道。
  if (event.type === "snapshot") {
    broadcastSnapshotSoon();
    return;
  }
  if (event.type === "thread.updated" && event.data?.id) {
    const agentId = event.data.agentId || "codex";
    const alias = threadSettings.sessionAlias(agentId, event.data.id);
    // 单条 thread.updated 也要带上 git：否则前端先按无分支渲染，
    // 等下一个快照才补出来，元信息行会跳一下。
    const decorated = decorateGit(askService.decorate(threadSettings.withDeferredSettings(event.data)));
    broadcast(
      JSON.stringify({
        ...event,
        data: alias && alias !== decorated.alias ? { ...decorated, alias } : decorated,
      }),
    );
    return;
  }
  broadcast(JSON.stringify(event));
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

console.log(`Codex Deck: http://${formatHost(host)}:${port}`);
// 启动先暖一轮 watcher 缓存：首个快照与首个接口调用直接命中，不用等扫描。
void watcherCache.ready();
// Git 分支同理：首个快照到达前先探测完，避免元信息行先渲染、再补出分支标签而闪动。
void Promise.all(
  [...new Set(initialThreads.map((thread) => thread.cwd).filter(Boolean))]
    .map(async (cwd) => {
      gitByCwd.set(cwd, await gitContexts.probe(cwd));
      gitSeenAt.set(cwd, Date.now());
    }),
).catch(() => undefined);
// 本机发现文件：deck-api 脚本从这里读地址与令牌，令牌不必出现在会话上下文里。
try {
  mkdirSync(deckHome, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(deckHome, "url"), `${localBase}\n`, { mode: 0o600 });
  writeFileSync(path.join(deckHome, "token"), `${token}\n`, { mode: 0o600 });
} catch (error: any) {
  console.error("写入唤醒发现文件失败:", error?.message || error);
}
// 与本版服务端配套的 deck-api 脚本装到 ~/.codex-deck/bin/：各项目里的
// skill 拷贝会转发到这里，不再因为拷贝过期而与接口脱节。内容相同不重写，
// 先写临时文件再改名，正在运行的 watcher 读到的始终是完整文件。
try {
  for (const script of ["deck-api", "deck-send", "deck-wake"]) {
    const source = readFileSync(
      path.join(projectRoot, `skills/${script}/scripts/${script}`),
      "utf8",
    );
    const installed = path.join(deckHome, "bin", script);
    const current = existsSync(installed) ? readFileSync(installed, "utf8") : "";
    if (current !== source) {
      mkdirSync(path.dirname(installed), { recursive: true, mode: 0o700 });
      const temporary = `${installed}.${process.pid}.tmp`;
      writeFileSync(temporary, source, { mode: 0o755 });
      chmodSync(temporary, 0o755);
      renameSync(temporary, installed);
    }
  }
} catch (error: any) {
  console.error("安装 Deck 调用脚本失败:", error?.message || error);
}
if (useWsl && wslDeckHome) {
  try {
    const wslBase = /127\.0\.0\.1|\[::1\]|localhost/.test(localBase)
      ? host === "0.0.0.0" || host === "::"
        ? lanAddresses(port, "", undefined, "ipv4")[0]?.replace(/\/$/, "")
        : undefined
      : localBase;
    const discoveryUrl = wslBase || localBase;
    await writeWslDiscovery(wslDeckHome, discoveryUrl, token);
    await installWslScripts(
      wslDeckHome,
      ["deck-api", "deck-send", "deck-wake"].map((script) => ({
        name: script,
        content: readFileSync(
          path.join(projectRoot, `skills/${script}/scripts/${script}`),
          "utf8",
        ),
      })),
    );
    if (/127\.0\.0\.1|\[::1\]|localhost/.test(discoveryUrl))
      process.stderr.write(
        "WSL 模式提示：WSL 与 Windows 默认不共享 127.0.0.1。若 deck-api 无法连接 Deck，请启用 WSL 镜像网络，或用 --host 绑定具体 LAN IP，或在 WSL 设置 DECK_API_URL。\n",
      );
  } catch (error: any) {
    console.error("写入 WSL 唤醒发现文件失败:", error?.message || error);
  }
}
if (lanListener) {
  const urls = lanAddresses(port, token, undefined, ipv6Host ? "ipv6" : "ipv4");
  if (urls.length) {
    process.stdout.write(`\n局域网手机入口：\n${urls.join("\n")}\n`);
    for (const url of urls) printQrCode(url);
  } else {
    process.stderr.write(
      ipv6Host
        ? "未检测到可用的局域网 IPv6 地址，请检查防火墙或网卡。\n"
        : "未检测到可用的局域网 IPv4 地址，请检查防火墙或网卡。\n",
    );
  }
}
if (cli.tunnel)
  tunnel = startTunnel(cli.tunnel, port, token, cli.cloudflaredBin);

if (pairing) {
  const seconds = Math.round(pairing.windowMs / 1000);
  pairing.start((code) =>
    process.stdout.write(
      `\n配对验证码：${code}（每 ${seconds} 秒更新；打开页面后在登录框输入）\n`,
    ),
  );
}

const runtimeStart = useWsl
  ? startPhase("正在启动 WSL 中的 Agent 服务…", {
      waitingLabel: "仍在等待 Codex 服务",
    })
  : undefined;
agents
  .startAll()
  .then(() => {
    runtimeStart?.done("Agent 服务已就绪");
    sessionSearch.reconcile();
  })
  .catch((error) => {
    runtimeStart?.fail(`Agent 启动失败：${error?.message || error}`);
    console.error("Agent 启动失败:", error);
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

const stopEventLoopHealth = startEventLoopHealth();
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) {
    // server.close 可能被存活连接卡住：二次信号不再等待，直接强退。
    console.error(`收到 ${signal}，强制退出`);
    process.exit(1);
  }
  shuttingDown = true;
  stopEventLoopHealth();
  // 先断全部 WS：否则 server.close 会等浏览器长连接，process.exit 永远到不了。
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {}
  }
  for (const client of toolWss.clients) {
    try {
      client.terminate();
    } catch {}
  }
  try {
    wss.close();
  } catch {}
  try {
    toolWss.close();
  } catch {}
  clearRuntimeLock(dataDir, process.pid);
  pairing?.stop();
  tunnel?.kill();
  messageDeliveries.close();
  agents.stopAll();
  tools.close();
  sessionSearch.close();
  closeCliProbes();
  closeBackgroundWork();
  askService.close();
  wakeOutbox.close();
  // 硬退出兜底：5 秒后无论如何结束进程。
  const hardExit = setTimeout(() => process.exit(0), 5_000);
  void threadSummaries
    .flush()
    .catch(() => undefined)
    .finally(() => {
      server.close(() => { clearTimeout(hardExit); process.exit(0); });
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Windows Ctrl+Break 只在 win32 上存在，其他平台注册会报错，故加守卫。
if (process.platform === "win32")
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
