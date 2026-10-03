import { RefreshCw } from "lucide-react";
import { agentProtocol, agentName, isAgentEnabled } from "../agents";
import { Badge, Button, Group, Row, Section, Switch } from "../kit";
import { agentHealth, type HealthTone } from "../monitor/health";
import type { AgentDescriptor } from "../types";
import type { AgentActions } from "./useAgentActions";

const DOT: Record<HealthTone, "ok" | "busy" | "warn" | "error" | "off"> = {
  ok: "ok",
  busy: "busy",
  warn: "warn",
  error: "error",
  off: "off",
};

/**
 * 副标题：只标例外。一切正常（在线、没有附注）时不写「在线」——状态点
 * 已经是绿的，每行再写一遍只是噪音。错误只显示第一行，完整内容放悬停。
 */
function statusText(agent: AgentDescriptor) {
  const health = agentHealth(agent);
  const detail =
    health.tone === "error" || health.tone === "warn"
      ? agent.error || agent.historyError
      : health.note;
  const first = (detail || "").split(/\r?\n/)[0].trim();
  if (health.tone === "off")
    return { text: first || health.label, full: first };
  if (health.tone === "ok" && health.label === "在线")
    return { text: first || undefined, full: detail || "" };
  return {
    text: first ? `${health.label} · ${first}` : health.label,
    full: detail || "",
    tone: health.tone === "error" ? ("danger" as const) : undefined,
  };
}

function AgentRow({
  agent,
  agents,
  actions,
  onOpen,
}: {
  agent: AgentDescriptor;
  agents: AgentDescriptor[];
  actions: AgentActions;
  onOpen?: () => void;
}) {
  const enabled = isAgentEnabled(agent);
  const health = agentHealth(agent);
  const pending = actions.pending[agent.id];
  const status = statusText(agent);
  const locked = agent.toggleable === false;
  return (
    <Row
      dot={DOT[health.tone]}
      dim={!enabled}
      title={agent.name}
      onOpen={onOpen}
      openLabel={onOpen ? `${agent.name} 设置` : undefined}
      badges={
        <>
          {locked ? (
            <Badge title="Codex 为核心 Agent：供应商与共享 Runtime 依附于它，不可停用">
              核心
            </Badge>
          ) : null}
          {agent.fallbackFor ? (
            <Badge
              tone="info"
              title={`${agentName(agents, { agentId: agent.fallbackFor })} 的备选：主 Agent 可用时，本 Agent 仅显示使用中的会话`}
            >
              备选{agent.standby ? " · 待命" : ""}
            </Badge>
          ) : null}
        </>
      }
      desc={status.text}
      descTone={status.tone ?? (health.tone === "off" ? "faint" : undefined)}
      descTitle={status.full || undefined}
      side={
        <>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            title={
              enabled
                ? `重载 ${agent.name}：重启后端并重新读取配置与会话`
                : `${agent.name} 未启用，启用后才能重载`
            }
            aria-label={`重载 ${agent.name}`}
            disabled={!enabled || Boolean(pending) || actions.reloadingAll}
            onClick={() => void actions.reload(agent)}
          >
            <RefreshCw
              className={pending === "reload" ? "ui-spin" : undefined}
            />
          </Button>
          <Switch
            checked={enabled}
            label={`启用 ${agent.name}`}
            title={
              locked
                ? "核心 Agent，不能停用"
                : enabled
                  ? `停用 ${agent.name}`
                  : `启用 ${agent.name}`
            }
            disabled={locked || actions.reloadingAll}
            busy={pending === "toggle"}
            onChange={(next) => void actions.toggle(agent, next)}
          />
        </>
      }
    />
  );
}

/** 「重载全部」按钮：放在页面标题右侧。 */
export function ReloadAllButton({ actions }: { actions: AgentActions }) {
  return (
    <Button
      size="sm"
      busy={actions.reloadingAll}
      title="按 acp-agents.json 增删改 ACP Agent，并重载全部已启用的 Agent；有会话运行的将跳过"
      onClick={() => void actions.reloadAll()}
    >
      <RefreshCw className={actions.reloadingAll ? "ui-spin" : undefined} />
      {actions.reloadingAll ? "重载中…" : "重载全部"}
    </Button>
  );
}

export function AgentsPanel({
  agents,
  actions,
  onOpen,
}: {
  agents: AgentDescriptor[];
  actions: AgentActions;
  /** 有详情页的 Agent：点行进入。 */
  onOpen?: (agent: AgentDescriptor) => (() => void) | undefined;
}) {
  const native = agents.filter((agent) => agentProtocol(agent) === "native");
  const acp = agents.filter((agent) => agentProtocol(agent) === "acp");
  const row = (agent: AgentDescriptor) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      agents={agents}
      actions={actions}
      onOpen={onOpen?.(agent)}
    />
  );
  return (
    <>
      {native.length ? (
        <Section title="原生">
          <Group>{native.map(row)}</Group>
        </Section>
      ) : null}
      <Section
        title="ACP"
        desc={
          acp.length
            ? undefined
            : "没有注册 ACP Agent。可在 .data/acp-agents.json 中声明 command/args 接入。"
        }
      >
        {acp.length ? <Group>{acp.map(row)}</Group> : null}
      </Section>
    </>
  );
}
