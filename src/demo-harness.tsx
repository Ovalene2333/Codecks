/**
 * 整站演示页：拦截 fetch 与 WebSocket，用假数据渲染真实 App（侧栏、总览、会话页、设置）。
 * 只用于视觉核对与 README 截图；`npm run dev` 后打开 /demo-harness.html。
 * ?theme=light 切浅色；?empty=1 看没有会话时的欢迎页。数据全部是虚构的演示项目。
 */
import type {
  AgentDescriptor,
  Approval,
  HostStats,
  Provider,
  RuntimeSnapshot,
  Snapshot,
  ThreadActivity,
  ThreadSummary,
} from "./types";
import type { ToolDescriptor } from "../plugin/types";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
localStorage.setItem(
  "codex-deck:appearance:v1",
  JSON.stringify({ theme, motion: "off", effects: "on" }),
);

// 桌面端默认把工具放到新标签页；演示页改为应用内打开，截图才抓得到。
localStorage.setItem("codex-deck:settings:v1", JSON.stringify({ toolOpenTarget: "inline" }));

const now = Date.now();
const ago = (seconds: number) => now - seconds * 1_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const capabilities: AgentDescriptor["capabilities"] = {
  approvals: true,
  archive: true,
  delete: true,
  fork: true,
  images: true,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  sessionSettings: true,
  shell: true,
  skills: false,
};

const AGENTS: AgentDescriptor[] = [
  { id: "codex", name: "Codex", available: true, online: true, historyStatus: "ready", capabilities },
  { id: "claude", name: "Claude Code", available: true, online: true, historyStatus: "ready", capabilities },
  { id: "opencode", name: "OpenCode", available: true, online: true, historyStatus: "ready", capabilities },
  { id: "devin", name: "Devin", protocol: "acp", available: true, online: true, capabilities },
];

const PROVIDERS: Provider[] = [
  { id: "official", name: "Official", kind: "local-profile", color: "#64748b", hasApiKey: true, enabled: true, online: true, current: true },
  { id: "relay", name: "中转 A", kind: "cc-switch", color: "#7c5cff", baseUrl: "https://relay-a.example.com/v1", hasApiKey: true, enabled: true, online: true },
  { id: "relay-b", name: "中转 B", kind: "cc-switch", color: "#0ea5e9", baseUrl: "https://relay-b.example.com/v1", hasApiKey: true, enabled: true, online: true },
];

// opencode.json 自定义 provider（演示数据，与 Codex/Claude 的 PROVIDERS 无关）。
const OPENCODE_PROVIDERS = [
  {
    id: "acme",
    name: "Acme 网关",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.acme.example.com/v1",
    hasApiKey: true,
    models: [
      { id: "claude-sonnet-5", variants: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5-codex" },
    ],
  },
  {
    id: "relay",
    name: "中转 A",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://relay-a.example.com/v1",
    hasApiKey: false,
    apiKeyHint: "{env:RELAY_A_KEY}",
    models: [
      { id: "claude-opus-5", variants: ["medium", "high"] },
      { id: "claude-sonnet-5", variants: ["medium", "high"] },
    ],
  },
  {
    id: "relay-b",
    name: "中转 B",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://relay-b.example.com/v1",
    hasApiKey: false,
    models: [{ id: "gpt-5-codex", variants: ["low", "high"] }],
  },
];

const RUNTIME: RuntimeSnapshot = {
  online: true,
  starting: false,
  remoteUrl: "",
  rateLimits: {
    planName: "Pro",
    primary: { usedPercent: 34, windowDurationMins: 300, resetAfterSeconds: 2 * 3_600 + 900 },
    secondary: { usedPercent: 41, windowDurationMins: 10_080, resetAfterSeconds: 3 * 86_400 },
  },
} as RuntimeSnapshot;

function thread(
  partial: Partial<ThreadSummary> & Pick<ThreadSummary, "id" | "name" | "cwd">,
): ThreadSummary {
  return {
    providerId: "official",
    agentId: "codex",
    model: "gpt-5.3-codex",
    preview: "",
    status: "idle",
    updatedAt: ago(1_800),
    ...partial,
  };
}

const SHOP = "/home/dev/shop-api";
const WEB = "/home/dev/web-dashboard";
const THREADS: ThreadSummary[] = [
  thread({ id: "retry", name: "修复订单超时重试", cwd: SHOP, status: "running", updatedAt: ago(5), activeTurnId: "t2", reasoningEffort: "high",
    tokenUsage: { total: 412_000, used: 94_000, limit: 256_000, input: 380_000, cachedInput: 210_000, output: 32_000 } }),
  thread({ id: "pinyin", name: "商品搜索支持拼音", cwd: SHOP, agentId: "opencode", providerId: "relay", status: "running", updatedAt: ago(120) }),
  thread({ id: "index", name: "补订单表索引迁移", cwd: SHOP, status: "waiting", updatedAt: ago(180) }),
  thread({ id: "idem", name: "支付回调幂等性", cwd: SHOP, agentId: "claude", providerId: "claude-local", claudeConnected: true, model: "claude-sonnet-5", status: "waiting", updatedAt: ago(300),
    tokenUsage: { total: 96_000, used: 74_000, limit: 200_000, input: 80_000, cachedInput: 52_000, output: 16_000 } }),
  thread({ id: "redis", name: "接入 Redis 限流", cwd: SHOP, agentId: "opencode", providerId: "relay", updatedAt: ago(1_260) }),
  thread({ id: "chart", name: "图表组件换虚拟列表", cwd: WEB, agentId: "claude", providerId: "claude-local", claudeConnected: true, model: "claude-opus-5", status: "running", updatedAt: ago(600),
    tokenUsage: { total: 1_250_000, used: 186_000, limit: 200_000, input: 1_100_000, cachedInput: 900_000, output: 150_000 } }),
  thread({ id: "dark", name: "暗色模式对比度", cwd: WEB, updatedAt: ago(2_700) }),
  thread({ id: "vite", name: "升级 Vite 7", cwd: WEB, updatedAt: ago(7_200) }),
  thread({ id: "eslint", name: "清理 ESLint 告警", cwd: WEB, updatedAt: ago(14_400) }),
  thread({ id: "notes", name: "整理 0.3.0 发布说明", cwd: "/home/dev/docs-site", agentId: "opencode", providerId: "relay", status: "waiting", updatedAt: ago(720) }),
  thread({ id: "push", name: "推送通知失败", cwd: "/home/dev/mobile-app", status: "error", updatedAt: ago(540),
    lastError: "PROVISIONING_PROFILE expired" }),
  thread({ id: "tf", name: "terraform plan 检查", cwd: "/home/dev/infra", agentId: "devin", updatedAt: ago(2_100) }),
];

const ACTIVITIES: ThreadActivity[] = [
  { agentId: "codex", threadId: "retry", turnStartedAt: ago(96), lastEventAt: ago(2),
    step: { startedAt: ago(8), item: { id: "c9", type: "commandExecution", command: "npm test -- orders" } } },
  { agentId: "opencode", threadId: "pinyin", turnStartedAt: ago(400), lastEventAt: ago(4),
    step: { startedAt: ago(5), item: { id: "e1", type: "commandExecution", tool: "edit", input: { filePath: `${SHOP}/src/search/pinyin.ts` } } } },
  { agentId: "claude", threadId: "chart", turnStartedAt: ago(1_500), lastEventAt: ago(330) },
  { agentId: "claude", threadId: "idem", turnStartedAt: ago(320), lastEventAt: ago(300) },
  { agentId: "opencode", threadId: "notes", turnStartedAt: ago(900), lastEventAt: ago(720) },
  { agentId: "codex", threadId: "push", lastEventAt: ago(540),
    lastTurn: { startedAt: ago(900), endedAt: ago(540), status: "failed", reply: "xcodebuild 失败：签名证书过期。" } },
  { agentId: "opencode", threadId: "redis", lastEventAt: ago(1_260),
    lastTurn: { startedAt: ago(1_600), endedAt: ago(1_260), status: "completed",
      reply: "限流接入完成：新增 RateLimiter（Redis 滑动窗口），/orders 与 /pay 已接入，默认每分钟 100 次。本地压测 p99 只增加了 1.8ms。" } },
  { agentId: "devin", threadId: "tf", lastEventAt: ago(2_100),
    lastTurn: { startedAt: ago(2_400), endedAt: ago(2_100), status: "completed",
      reply: "Plan 完成：新增 3 个资源（aws_s3_bucket.logs、aws_iam_role.ci、aws_cloudwatch_log_group.api），修改 1 个安全组放行 443，没有销毁操作，可以直接 apply。" } },
  { agentId: "codex", threadId: "dark", lastEventAt: ago(2_700),
    lastTurn: { startedAt: ago(3_000), endedAt: ago(2_700), status: "completed", reply: "正文与次要文字的对比度都已达到 4.5:1 以上，按钮描边改用 --line-strong。" } },
];

const APPROVALS: Approval[] = [
  { id: "idem:approval-1", providerId: "claude-local", agentId: "claude", kind: "command",
    request: { method: "exec", params: { threadId: "idem", command: "docker compose down -v && docker compose up -d db" } },
    command: "docker compose down -v && docker compose up -d db", cwd: SHOP, reason: "重置本地数据库，复现回调重复处理" },
  { id: "index:approval-2", providerId: "official", agentId: "codex", kind: "file",
    request: { method: "item/fileChange/requestApproval", params: { threadId: "index" } },
    changes: [{ path: `${SHOP}/migrations/0042_orders_created_at.sql`, kind: "add", diff: "+CREATE INDEX idx_orders_created_at ON orders (created_at);\n" }],
    cwd: SHOP },
  // 当前演示会话自己的审批：会话页显示在输入框上方，全局浮窗只提示上面两条。
  ...(params.has("dock")
    ? [{ id: "retry:approval-3", providerId: "official", agentId: "codex", kind: "command",
        request: { method: "item/commandExecution/requestApproval", params: { threadId: "retry" } },
        command: "npm test -- orders --runInBand", cwd: SHOP, reason: "跑订单相关测试，确认重试只产生一个订单" } as Approval]
    : []),
];

const empty = params.has("empty");
const TOOLS: ToolDescriptor[] = [
  { id: "terminal", name: "网页终端", description: "通过浏览器连接本机的交互式终端", icon: "terminal", available: true, pagePath: "/terminal", defaultCwd: SHOP },
  { id: "git", name: "Git 管理", description: "查看改动、管理暂存区与分支，并同步远端仓库", icon: "git-branch", available: true, pagePath: "/git", defaultCwd: SHOP },
  { id: "text-editor", name: "文本编辑器", description: "浏览宿主机文件系统，查看、编辑、查找并保存文本文件", icon: "file-pen", available: true, pagePath: "/text-editor", defaultCwd: SHOP },
  { id: "commands", name: "快捷指令", description: "在指定目录一键执行常用指令，命令里可用 {参数名} 占位符带参执行", icon: "zap", available: true, pagePath: "/commands", defaultCwd: SHOP },
];

const QUICK_COMMANDS = [
  { id: "q1", name: "跑订单测试", command: "npm test -- {pattern}", cwd: SHOP },
  { id: "q2", name: "重启本地数据库", command: "docker compose restart db", cwd: SHOP },
  { id: "q3", name: "构建体积分析", command: "npm run build -- --analyze", cwd: WEB },
  { id: "q4", name: "看线上日志", command: "kubectl logs deploy/shop-api --tail 200" },
  { id: "q5", name: "查端口占用", command: "lsof -i :{port}" },
].map((item, index) => ({ ...item, createdAt: ago(86_400 * (index + 1)), updatedAt: ago(3_600 * (index + 1)) }));

const QUICK_OUTPUT = `> shop-api@2.4.0 test
> node --test test/orders

✔ 创建订单会扣款一次 (31ms)
✔ 网关超时后重试只产生一个订单 (112ms)
✔ 4xx 不重试 (9ms)
✔ 幂等键相同只创建一次 (14ms)

ℹ tests 14
ℹ pass 14
ℹ fail 0
`;

const SNAPSHOT: Snapshot = {
  agents: AGENTS,
  providers: PROVIDERS,
  threads: empty ? [] : THREADS,
  archivedThreads: [],
  approvals: empty ? [] : APPROVALS,
  activities: empty ? [] : ACTIVITIES,
  wakeDeliveries: [],
  wakeWatchers: [],
  projects: [
    { key: "shop", cwd: SHOP, name: "shop-api", pinned: true, updatedAt: now },
    { key: "web", cwd: WEB, name: "web-dashboard", updatedAt: now },
  ] as Snapshot["projects"],
  preferences: { recentDirs: [SHOP, WEB] },
  runtime: RUNTIME,
  tools: TOOLS,
  agentProfiles: [
    { id: "claude-local", agentId: "claude", name: "本机 Claude", kind: "local-profile", color: "#d97757", current: true, official: true, enabled: true, online: true },
  ],
  server: {
    version: "0.3.0", node: "v22.12.0", platform: "linux", wsl: false,
    startedAt: ago(3 * 3_600), dataDir: "/home/dev/.codecks", ccSwitch: "/home/dev/.cc-switch/cc-switch.db",
  },
};

localStorage.setItem(
  "codex-deck:unseen-sessions:v1",
  JSON.stringify(["opencode:relay:redis", "devin:official:tf", "codex:official:dark", "codex:official:push"]),
);

const DIFF = `@@ -8,10 +8,18 @@ export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions) {
-    await sleep(opts.baseMs * 2 ** attempt);
+    const cap = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
+    await sleep(Math.random() * cap); // full jitter
`;

const TURNS = [
  {
    id: "t1", status: "completed", startedAt: ago(1_200), completedAt: ago(900),
    items: [
      { id: "u1", type: "userMessage", content: [{ type: "text", text: "网关超时后订单会重复创建，修一下重试逻辑，要求幂等。" }] },
      { id: "a1", type: "agentMessage", text: "改好了，订单相关的 14 个测试全部通过。重试现在会复用同一个幂等键，网关超时后只会产生一个订单。" },
    ],
  },
  {
    id: "t2", status: "inProgress", startedAt: ago(96),
    items: [
      { id: "u2", type: "userMessage", content: [{ type: "text", text: "再加一层：退避带抖动，避免多个实例同时重试。最大重试次数也做成配置项。" }] },
      { id: "a2", type: "agentMessage", phase: "commentary", text: "好。我先看一下现在的退避是怎么算的，再改成指数退避加 full jitter，最大次数走 `ORDER_RETRY_MAX`。" },
      { id: "c1", type: "commandExecution", command: "sed -n 1,80p src/orders/retry.ts", status: "completed", exitCode: 0,
        commandActions: [{ type: "read", path: "src/orders/retry.ts", name: "retry.ts" }] },
      { id: "c2", type: "commandExecution", command: "rg -n 'backoff|retryDelay' src", status: "completed", exitCode: 0,
        commandActions: [{ type: "search", query: "backoff|retryDelay", path: "src" }] },
      { id: "f1", type: "fileChange", status: "completed", changes: [
        { path: `${SHOP}/src/orders/retry.ts`, kind: "update", diff: DIFF },
        { path: `${SHOP}/src/config.ts`, kind: "update", diff: "@@ -3,3 +3,4 @@\n+  orderRetryMax: Number(process.env.ORDER_RETRY_MAX ?? 5),\n" },
      ] },
      { id: "a3", type: "agentMessage", phase: "commentary", text: "改完了。抖动用的是 full jitter：`delay = random(0, min(cap, base * 2^n))`，几个实例不会再踩在同一个时间点上。\n\n接下来把订单相关的测试再跑一遍。" },
      { id: "c9", type: "commandExecution", command: "npm test -- orders", status: "inProgress" },
    ],
  },
];

const IDEM_TURNS = [
  {
    id: "i1", status: "inProgress", startedAt: ago(420),
    items: [
      { id: "iu", type: "userMessage", content: [{ type: "text", text: "支付回调偶尔会被重复处理，先在本地把问题复现出来。" }] },
      { id: "ic", type: "commandExecution", command: "cat src/payments/callback.ts", status: "completed", exitCode: 0,
        commandActions: [{ type: "read", path: "src/payments/callback.ts", name: "callback.ts" }] },
      { id: "ia", type: "agentMessage", phase: "commentary", text: "我先看一下回调的处理流程，再想办法在本地构造重复投递。" },
    ],
  },
];

const HOST: HostStats = {
  platform: "linux", arch: "x64", cpuCount: 16, cpuPercent: 37, loadavg: [3.12, 2.87, 2.4],
  memTotal: 32 * GB, memAvailable: 9 * GB, uptimeSec: 86_400 * 3,
  deck: { pid: 4242, rss: 212 * MB, heapUsed: 96 * MB, uptimeSec: 3 * 3_600 + 720, node: "v22.12.0", clients: 2 },
  servers: [
    { agentId: "codex", pid: 4243, rss: 148 * MB },
    { agentId: "opencode", pid: 4244, rss: 736 * MB },
    { agentId: "devin", pid: 4245, rss: 612 * MB },
  ],
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const path = url.pathname.slice(4);
  const method = (init?.method || "GET").toUpperCase();
  if (params.has("debug")) console.debug("[demo]", method, path);
  if (path === "/health") return json({ ok: true, authRequired: false, pairing: false });
  if (path === "/snapshot") return json(SNAPSHOT);
  if (path === "/agents/opencode/providers")
    return json({
      online: true,
      global: {
        scope: "global",
        path: "/home/dev/.config/opencode/opencode.jsonc",
        exists: true,
        providers: OPENCODE_PROVIDERS,
      },
    });
  if (path === "/monitor/host") return json(HOST);
  if (path === "/monitor/watchers") return json({ items: [] });
  if (path === "/tasks") return json({ tasks: [] });
  if (path === "/tools") return json({ tools: TOOLS });
  if (path === "/tools/commands/run") {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.action === "list") return json({ commands: QUICK_COMMANDS });
    if (body.action === "exec")
      return json({
        command: String(body.command || "").replace("{pattern}", body.params?.pattern || ""),
        cwd: body.cwd, code: 0, stdout: QUICK_OUTPUT, stderr: "",
        durationMs: 8_200, timedOut: false, truncated: false,
      });
  }
  const match = path.match(/^\/agents\/([^/]+)\/threads\/([^/]+)$/);
  if (match && method === "GET") {
    const found = THREADS.find((item) => item.id === decodeURIComponent(match[2]));
    if (!found) return json({ error: "not found" }, 404);
    return json({ ...found, turns: found.id === "retry" ? TURNS : found.id === "idem" ? IDEM_TURNS : [] });
  }
  return json({});
};

class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public url: string) {
    super();
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", data: SNAPSHOT }) }));
    }, 30);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
(window as any).WebSocket = DemoSocket;

await import("./main");
