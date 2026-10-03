import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { MobileTabBar, useMobileLayout } from "./layout/MobileNav";
import { MonitorPanel } from "./monitor/MonitorPanel";
import { resetActivities } from "./monitor/activity-store";
import { mergeProjectGroups } from "./projects";
import { ToastStack } from "./ui";
import type {
  AgentDescriptor,
  Approval,
  HostStats,
  Provider,
  RuntimeSnapshot,
  ThreadActivity,
  ThreadSummary,
  WakeDelivery,
  WakeWatcher,
} from "./types";
import "./styles.css";
import "./project-groups.css";
import "./sidebar.css";
import "./chat.css";
import "./approval-inbox.css";
import "./overlays.css";
import "./tokens.css";
import "./polish.css";
import "./appearance.css";
import "./task-tools.css";
import "./deck-ui.css";
import "./monitor.css";
import "./search-picker.css";
import "./mobile-nav.css";
import "./kit.css";
import "./settings.css";

// ?theme=light 切浅色；默认深色。
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = theme;

const now = Date.now();
const ago = (seconds: number) => now - seconds * 1_000;
const GB = 1024 ** 3;

// 预览页没有后端：本机资源接口直接给假数据，其余请求照常失败。
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (String(input).endsWith("/api/monitor/host")) {
    const stats: HostStats = {
      platform: "linux",
      arch: "x64",
      cpuCount: 16,
      cpuPercent: 37 + Math.random() * 8,
      loadavg: [3.12, 2.87, 2.4],
      memTotal: 32 * GB,
      memAvailable: 9.4 * GB,
      uptimeSec: 86_400 * 3,
      deck: {
        pid: 4242,
        rss: 212 * 1024 ** 2,
        heapUsed: 96 * 1024 ** 2,
        uptimeSec: 3 * 3_600 + 720,
        node: "v22.12.0",
        clients: 2,
      },
      servers: [
        { agentId: "codex", pid: 4243, rss: 148 * 1024 ** 2 },
        { agentId: "opencode", pid: 4244, rss: 736 * 1024 ** 2 },
        { agentId: "devin", pid: 4245, rss: 1_900 * 1024 ** 2 },
      ],
    };
    return new Response(JSON.stringify(stats), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (String(input).endsWith("/api/monitor/watchers")) {
    // ?watchers=0 预览「监督中」的空态。
    const empty = new URLSearchParams(location.search).get("watchers") === "0";
    const items: WakeWatcher[] = empty ? [] : [
      {
        pid: 1358291,
        code: "f61d9535",
        mode: "poll",
        label: "report-heads-g2v2",
        intervalSec: 300,
        command: "ssh -o BatchMode=yes hlt R=/data/runs/report_heads_g2v2; test -f $R/PIPELINE_COMPLETE && echo DONE || echo RUNNING",
        startedAt: ago(12 * 3_600 + 2_400),
        state: "RUNNING",
        stateAt: ago(12 * 3_600 + 2_400),
        log: "/home/ovalene/.codex-deck/watch/f61d9535-20260929-120808.log",
        agentId: "claude",
        threadId: "heads",
      },
      {
        pid: 20411,
        code: "gpu",
        mode: "watch",
        label: "train-r3",
        command: "ssh -o BatchMode=yes gpu-box 'while kill -0 12345 2>/dev/null; do sleep 60; done; tail -n 30 ~/runs/r3/train.log'",
        startedAt: ago(3 * 3_600 + 600),
        agentId: "codex",
        threadId: "dotfiles",
      },
      {
        pid: 20877,
        code: "hpc-4821",
        mode: "poll",
        label: "job-4821",
        intervalSec: 120,
        command: "ssh -o BatchMode=yes hpc 'sacct -j 4821 -n -X -o State | head -1'",
        startedAt: ago(2_400),
        state: "PENDING",
        stateAt: ago(2_300),
        failures: 3,
      },
    ];
    return new Response(JSON.stringify({ items }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(input, init);
};

const PROVIDERS: Provider[] = [
  { id: "official", name: "Official", kind: "local-profile", color: "#8b5cf6", hasApiKey: true, enabled: true, online: true, current: true },
  { id: "relay", name: "Relay", kind: "custom", color: "#0ea5e9", hasApiKey: true, enabled: true, online: true },
  { id: "backup", name: "Backup", kind: "custom", color: "#f59e0b", hasApiKey: true, enabled: true, online: false, error: "401 Unauthorized：API Key 无效" },
];

const capabilities = {} as AgentDescriptor["capabilities"];
const AGENTS: AgentDescriptor[] = [
  { id: "codex", name: "Codex", available: true, online: true, historyStatus: "ready", capabilities },
  { id: "claude", name: "Claude Code", available: true, online: true, historyStatus: "ready", error: "上一轮：Request timed out", capabilities },
  { id: "opencode", name: "OpenCode", available: true, online: false, starting: true, capabilities },
  { id: "devin", name: "Devin", protocol: "acp", available: true, online: false, error: "spawn devin ENOENT", capabilities },
];

const RUNTIME: RuntimeSnapshot = {
  online: true,
  starting: false,
  remoteUrl: "",
  rateLimits: {
    planName: "Pro",
    primary: { usedPercent: 38, windowDurationMins: 300, resetAfterSeconds: 2 * 3_600 + 900 },
    secondary: { usedPercent: 88, windowDurationMins: 10_080, resetAfterSeconds: 3 * 86_400 },
  },
};

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

const THREADS: ThreadSummary[] = [
  thread({
    id: "tiled",
    name: "tiled-mode",
    cwd: "/home/ovalene/Codecks",
    status: "running",
    updatedAt: ago(20),
    preview: "正在生成平铺布局组件",
    tokenUsage: { total: 412_000, used: 184_000, limit: 256_000, input: 380_000, cachedInput: 210_000, output: 32_000 },
  }),
  thread({
    id: "etl",
    name: "nightly-etl",
    cwd: "/home/ovalene/work/data-pipeline",
    agentId: "opencode",
    providerId: "relay",
    status: "running",
    updatedAt: ago(90),
    preview: "merge 阶段 3/5 · writing partitioned output",
    tokenUsage: { total: 96_000, used: 41_000, limit: 200_000, input: 88_000, output: 8_000 },
  }),
  thread({
    id: "refactor",
    name: "auth-refactor",
    cwd: "/home/ovalene/work/api-gateway",
    agentId: "claude",
    model: "claude-opus-5-5",
    status: "running",
    updatedAt: ago(600),
    preview: "拆分 session 中间件",
    tokenUsage: { total: 1_250_000, used: 186_000, limit: 200_000, input: 1_100_000, cachedInput: 900_000, output: 150_000 },
  }),
  thread({
    id: "gateway",
    name: "retry-backoff",
    cwd: "/home/ovalene/work/api-gateway",
    agentId: "claude",
    model: "claude-sonnet-5",
    status: "waiting",
    updatedAt: ago(240),
    preview: "需要删除 tmp/certs 并重新生成",
  }),
  thread({
    id: "schema",
    name: "db-migration",
    cwd: "/home/ovalene/work/data-pipeline",
    status: "waiting",
    updatedAt: ago(120),
    preview: "准备写入迁移脚本",
  }),
  thread({
    id: "mobile",
    name: "push-notify",
    cwd: "/home/ovalene/work/mobile-app",
    status: "error",
    updatedAt: ago(540),
    lastError: "PROVISIONING_PROFILE expired\nxcodebuild exited with 65",
    preview: "构建失败：签名证书过期",
  }),
  thread({
    id: "infra",
    name: "terraform-plan",
    cwd: "/home/ovalene/work/infra",
    agentId: "opencode",
    providerId: "relay",
    updatedAt: ago(2_700),
    preview: "plan 完成：+3 ~1 -0",
    tokenUsage: { total: 58_000, used: 58_000, limit: 200_000 },
  }),
  thread({
    id: "docs",
    name: "i18n-zh",
    cwd: "/home/ovalene/work/docs-site",
    agentId: "claude",
    providerId: "relay",
    updatedAt: ago(7_200),
    preview: "中文翻译已同步到 87%",
    locked: true,
  }),
  thread({
    id: "flaky",
    name: "flaky-e2e",
    cwd: "/home/ovalene/work/mobile-app",
    agentId: "claude",
    updatedAt: ago(3_900),
    preview: "定位偶发失败的 e2e 用例",
  }),
  thread({
    id: "bench",
    name: "perf-bench",
    cwd: "/home/ovalene/Codecks",
    agentId: "opencode",
    providerId: "relay",
    updatedAt: ago(5_400),
    preview: "对比两种虚拟列表实现",
  }),
  thread({
    id: "ask",
    name: "release-notes",
    cwd: "/home/ovalene/Codecks",
    agentId: "claude",
    status: "waiting",
    updatedAt: ago(780),
    preview: "整理 0.3.0 发布说明",
  }),
  thread({
    id: "heads",
    name: "report-heads 分析",
    cwd: "/home/ovalene/code/RL",
    agentId: "claude",
    updatedAt: ago(45_000),
    preview: "g2v2 报告头训练，结束后自动分析",
  }),
  thread({
    id: "dotfiles",
    name: "nvim-config",
    cwd: "/home/ovalene/dotfiles",
    updatedAt: ago(200_000),
    preview: "lazy.nvim 插件已锁定版本",
  }),
];

// 唤醒投递示例：一条正在退避重试、一条 dead 待人处理、一条会话已不在。
const DELIVERIES: WakeDelivery[] = [
  {
    id: "d1",
    code: "f61d9535",
    status: "pending",
    agentId: "claude",
    threadId: "heads",
    attempts: 3,
    createdAt: ago(1_200),
    updatedAt: ago(60),
    nextAttemptAt: now + 4 * 60_000,
    lastError: "Claude Code 会话正在运行",
    preview: "[report-heads-g2v2] 任务结束：RUNNING -> COMPLETED",
  },
  {
    id: "d2",
    code: "etl-done",
    status: "dead",
    agentId: "opencode",
    threadId: "etl",
    attempts: 1,
    createdAt: ago(3_600),
    updatedAt: ago(3_540),
    lastError: "会话已归档，请先恢复再发送",
    preview: "[nightly-etl] 命令结束 exit=0，用时 2h04m",
  },
  {
    id: "d3",
    code: "hpc-4821",
    status: "dead",
    agentId: "opencode",
    threadId: "gone-session",
    attempts: 7,
    createdAt: ago(90_000),
    updatedAt: ago(80_000),
    lastError: "OpenCode 连接闪断（fetch failed）（ECONNRESET），重试即可恢复",
    preview: "[job-4821] 任务结束：RUNNING -> FAILED",
  },
];

const ACTIVITIES: ThreadActivity[] = [
  {
    agentId: "codex",
    threadId: "tiled",
    turnStartedAt: ago(192),
    lastEventAt: ago(2),
    step: {
      startedAt: ago(42),
      item: { id: "c1", type: "commandExecution", command: "/bin/bash -lc 'npx tsc --noEmit -p tsconfig.json'" },
    },
  },
  {
    agentId: "opencode",
    threadId: "etl",
    turnStartedAt: ago(1_260),
    lastEventAt: ago(4),
    step: {
      startedAt: ago(6),
      item: { id: "e1", type: "commandExecution", tool: "edit", input: { filePath: "/home/ovalene/work/data-pipeline/jobs/merge.py" } },
    },
  },
  { agentId: "claude", threadId: "refactor", turnStartedAt: ago(1_500), lastEventAt: ago(330) },
  { agentId: "claude", threadId: "gateway", turnStartedAt: ago(300), lastEventAt: ago(240) },
  { agentId: "claude", threadId: "ask", turnStartedAt: ago(900), lastEventAt: ago(780) },
  {
    agentId: "codex",
    threadId: "mobile",
    lastEventAt: ago(540),
    lastTurn: { startedAt: ago(900), endedAt: ago(540), status: "failed", reply: "xcodebuild 失败：签名证书过期。" },
  },
  {
    agentId: "opencode",
    threadId: "infra",
    lastEventAt: ago(2_700),
    lastTurn: {
      startedAt: ago(2_952),
      endedAt: ago(2_700),
      status: "completed",
      reply: "## Plan 完成\n\n- 新增 3 个资源：`aws_s3_bucket.logs`、`aws_iam_role.ci`、`aws_cloudwatch_log_group.api`\n- 修改 1 个：安全组放行 443\n\n没有销毁操作，可以直接 apply。",
    },
  },
  {
    agentId: "claude",
    threadId: "docs",
    lastEventAt: ago(7_200),
    lastTurn: {
      startedAt: ago(8_100),
      endedAt: ago(7_200),
      status: "completed",
      reply: "中文翻译已同步到 87%，剩下的 12 页是 API 参考，需要你确认术语表后再继续。",
    },
  },
  {
    agentId: "claude",
    threadId: "flaky",
    lastEventAt: ago(3_900),
    lastTurn: { startedAt: ago(4_300), endedAt: ago(3_900), status: "interrupted", reply: "复现了 3 次，怀疑是动画未结束就断言，" },
  },
  {
    agentId: "opencode",
    threadId: "bench",
    lastEventAt: ago(5_400),
    lastTurn: { startedAt: ago(6_000), endedAt: ago(5_400), status: "completed" },
  },
];
resetActivities(ACTIVITIES);

const APPROVALS: Approval[] = [
  {
    id: "gateway:approval-1",
    providerId: "official",
    agentId: "claude",
    kind: "command",
    request: { method: "exec", params: { threadId: "gateway", command: "rm -rf tmp/certs && ./regen-certs.sh" } },
    command: "rm -rf tmp/certs && ./regen-certs.sh",
    cwd: "/home/ovalene/work/api-gateway",
  },
  {
    id: "schema:approval-2",
    providerId: "official",
    agentId: "codex",
    kind: "file",
    request: { method: "item/fileChange/requestApproval", params: { threadId: "schema" } },
    changes: [
      { path: "/home/ovalene/work/data-pipeline/migrations/0042_add_index.sql", kind: "add", diff: "+CREATE INDEX idx_events_ts ON events (ts);\n" },
    ],
    cwd: "/home/ovalene/work/data-pipeline",
  },
];

const PROJECTS = [
  { key: "codecks", cwd: "/home/ovalene/Codecks", name: "codex-deck", pinned: true, updatedAt: now },
  { key: "pipeline", cwd: "/home/ovalene/work/data-pipeline", name: "data-pipeline", updatedAt: now },
  { key: "gateway", cwd: "/home/ovalene/work/api-gateway", name: "api-gateway", updatedAt: now },
];

function Harness() {
  const [approvals, setApprovals] = useState(APPROVALS);
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const groups = useMemo(() => mergeProjectGroups(PROJECTS, THREADS), []);
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        "codex:official:mobile",
        "opencode:relay:infra",
        "claude:relay:docs",
        "claude:official:flaky",
        "opencode:relay:bench",
      ]),
  );
  const toast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2_000,
    );
  };
  const mobile = useMobileLayout();
  return (
    <div className={`app-shell${mobile ? " has-tabbar" : ""}`}>
      <section className="workspace">
        <MonitorPanel
          groups={groups}
          unseenSessions={unseen}
          approvals={approvals}
          providers={PROVIDERS}
          agents={AGENTS}
          runtime={RUNTIME}
          threads={THREADS}
          liveThreads={THREADS}
          deliveries={DELIVERIES}
          searchMatches={new Map()}
          query=""
          loading={false}
          notificationPermission="default"
          onSelect={(item) => toast(`打开 ${item.name}`)}
          onOpenThread={(item) => toast(`打开 ${item.name}`)}
          onShowAll={() => toast("查看全部会话")}
          onNew={() => toast("新建会话")}
          onAppearance={() => toast("外观设置")}
          onMarkSeen={(key) =>
            setUnseen((current) => new Set([...current].filter((item) => item !== key)))
          }
          onMarkAllSeen={() => setUnseen(new Set())}
          onSessionMenu={(item) => toast(`${item.name} 的菜单`)}
          onHistory={(item) => toast(`${item.name} 的历史`)}
          onResolveApproval={(id, body) => {
            setApprovals((current) => current.filter((item) => item.id !== id));
            toast(body.decision === "decline" ? "已拒绝" : "已批准");
          }}
          onRequestNotifications={() => toast("开启系统提醒")}
          onRefreshLimits={async () => toast("刷新额度")}
          onOpenUsage={() => toast("打开用量明细")}
        />
      </section>
      {mobile && (
        <MobileTabBar
          active="home"
          homeBadge={approvals.length}
          sessionsBadge={unseen.size}
          onHome={() => toast("总览")}
          onSessions={() => toast("会话列表")}
          onNew={() => toast("新建会话")}
          onTools={() => toast("工具")}
          onSettings={() => toast("设置")}
        />
      )}
      <ToastStack toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
