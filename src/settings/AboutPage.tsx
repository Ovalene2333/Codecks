import { useEffect, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { isAgentEnabled } from "../agents";
import { copyText } from "../clipboard";
import { Badge, Button, Group, Note, Row, Section } from "../kit";
import type { DeckNotificationPermission } from "../notifications";
import type { Snapshot } from "../types";

const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const APP_REPO = typeof __APP_REPO__ === "string" ? __APP_REPO__ : "";

function formatUptime(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function platformLabel(platform?: string, wsl?: boolean) {
  const name =
    platform === "win32"
      ? "Windows"
      : platform === "darwin"
        ? "macOS"
        : platform === "linux"
          ? "Linux"
          : platform || "未知";
  return wsl ? `${name} · WSL Runtime` : name;
}

function browserLabel() {
  const ua = navigator.userAgent;
  const match =
    ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/) || undefined;
  const engine = match
    ? match[1] === "Edg"
      ? "Edge"
      : match[1] === "OPR"
        ? "Opera"
        : match[1] === "Version"
          ? "Safari"
          : match[1]
    : "浏览器";
  const major = match?.[2]?.split(".")[0];
  return major ? `${engine} ${major}` : engine;
}

const standalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

/** 关于：版本、服务端与本设备信息，一键复制诊断信息（不含令牌与 Key）。 */
export function AboutPage({
  snapshot,
  notificationPermission,
  onToast,
}: {
  snapshot: Snapshot;
  notificationPermission: DeckNotificationPermission;
  onToast: (message: string) => void;
}) {
  const server = snapshot.server;
  const runtime = snapshot.runtime;
  const agents = snapshot.agents || [];
  const enabled = agents.filter(isAgentEnabled);
  const online = enabled.filter((agent) => agent.online);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const mismatch = Boolean(
    APP_VERSION && server?.version && APP_VERSION !== server.version,
  );

  const diagnostics = () => ({
    app: {
      web: APP_VERSION || null,
      server: server?.version || null,
      repo: APP_REPO || null,
    },
    server: server
      ? {
          platform: server.platform,
          wsl: server.wsl,
          node: server.node,
          uptimeMinutes: Math.round((now - server.startedAt) / 60_000),
          ccSwitch: Boolean(server.ccSwitch),
        }
      : null,
    runtime: runtime
      ? {
          online: runtime.online,
          starting: runtime.starting,
          configPending: Boolean(runtime.configPending),
          error: runtime.error?.split(/\r?\n/)[0] || null,
        }
      : null,
    agents: agents.map((agent) => ({
      id: agent.id,
      protocol: agent.protocol || "native",
      enabled: isAgentEnabled(agent),
      online: agent.online,
      history: agent.historyStatus || null,
      error: agent.error?.split(/\r?\n/)[0] || null,
    })),
    providers: snapshot.providers.map((provider) => ({
      kind: provider.kind,
      online: provider.online,
      current: Boolean(provider.current),
      error: Boolean(provider.error),
    })),
    sessions: {
      active: snapshot.threads.length,
      archived: snapshot.archivedThreads?.length || 0,
      approvals: snapshot.approvals.length,
    },
    device: {
      userAgent: navigator.userAgent,
      standalone: standalone(),
      notifications: notificationPermission,
      viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
    },
  });

  return (
    <>
      {mismatch ? (
        <Note
          tone="warn"
          icon={<RefreshCw />}
          title="页面版本与服务端不一致"
          action={
            <Button size="sm" variant="primary" onClick={() => location.reload()}>
              刷新
            </Button>
          }
        >
          服务端已更新至 {server?.version}，当前页面为 {APP_VERSION}。刷新后使用新版本。
        </Note>
      ) : null}
      <Section title="版本">
        <Group>
          <Row
            title="Codex Deck"
            badges={APP_VERSION ? <Badge>{APP_VERSION}</Badge> : null}
            desc="移动端优先的多 Agent 远程控制台"
          />
          {server ? (
            <Row
              title="服务端"
              badges={
                server.version ? (
                  <Badge tone={mismatch ? "warn" : "neutral"}>
                    {server.version}
                  </Badge>
                ) : null
              }
              desc={`${platformLabel(server.platform, server.wsl)} · Node ${server.node.replace(/^v/, "")} · 已运行 ${formatUptime(now - server.startedAt)}`}
            />
          ) : (
            <Row
              title="服务端"
              desc="服务端版本较旧，未提供版本信息"
              descTone="faint"
            />
          )}
          {APP_REPO ? (
            <Row
              title="源代码"
              desc={APP_REPO.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
              side={
                <Button
                  size="sm"
                  onClick={() =>
                    window.open(APP_REPO, "_blank", "noopener")
                  }
                >
                  <ExternalLink />
                  GitHub
                </Button>
              }
            />
          ) : null}
        </Group>
      </Section>
      <Section title="状态">
        <Group>
          <Row
            dot={runtime?.online ? "ok" : runtime?.starting ? "busy" : "error"}
            title="Codex Runtime"
            desc={
              runtime?.online
                ? runtime.remoteUrl
                : runtime?.starting
                  ? "启动中"
                  : runtime?.error?.split(/\r?\n/)[0] || "未运行"
            }
            descTitle={runtime?.error}
          />
          <Row
            dot={online.length === enabled.length ? "ok" : "warn"}
            title="Agent"
            desc={`${online.length} / ${enabled.length} 个已启用的在线${
              agents.length > enabled.length
                ? ` · ${agents.length - enabled.length} 个未启用`
                : ""
            }`}
          />
          {server ? (
            <>
              <Row title="数据目录" desc={<code>{server.dataDir}</code>} />
              <Row
                title="CC Switch"
                desc={
                  server.ccSwitch ? <code>{server.ccSwitch}</code> : "未找到"
                }
                descTone={server.ccSwitch ? undefined : "faint"}
              />
            </>
          ) : null}
        </Group>
      </Section>
      <Section title="本设备">
        <Group>
          <Row
            title={browserLabel()}
            desc={`${standalone() ? "已安装为应用" : "在浏览器中打开"} · ${window.innerWidth}×${window.innerHeight}`}
          />
        </Group>
      </Section>
      <Section
        title="诊断"
        desc="提交问题时请附上。仅含版本、状态与错误首行，不含令牌、API Key 与会话内容。"
      >
        <Group>
          <Row
            title="诊断信息"
            desc="复制为 JSON"
            side={
              <Button
                size="sm"
                onClick={async () =>
                  onToast(
                    (await copyText(JSON.stringify(diagnostics(), null, 2)))
                      ? "已复制诊断信息"
                      : "复制失败",
                  )
                }
              >
                <Copy />
                复制
              </Button>
            }
          />
        </Group>
      </Section>
    </>
  );
}
