import type { AgentDescriptor, Provider, ThreadSummary } from "../types";

export type HealthTone = "ok" | "busy" | "warn" | "error" | "off";

export interface AgentHealth {
  tone: HealthTone;
  label: string;
  /** 在线但最近一次回合报过错：只作提示，不算健康问题。 */
  note?: string;
}

export function agentHealth(agent: AgentDescriptor): AgentHealth {
  if (agent.enabled === false)
    return {
      tone: "off",
      label: "未启用",
      note:
        agent.disabledReason === "default"
          ? agent.defaultNote || "默认不加载"
          : "已在设置中停用",
    };
  if (!agent.available) return { tone: "off", label: "未启用" };
  if (agent.starting) return { tone: "busy", label: "启动中" };
  if (!agent.online)
    return { tone: agent.error ? "error" : "warn", label: agent.error ? "启动失败" : "离线" };
  if (agent.standby)
    return {
      tone: "ok",
      label: "备选待命",
      note: `主 agent 可用，${agent.name} 的重复会话已隐藏`,
    };
  if (agent.historyStatus === "error")
    return { tone: "warn", label: "历史读取失败", note: agent.historyError };
  if (agent.historyStatus === "loading" || agent.historyStatus === "cached")
    return { tone: "busy", label: "同步历史", note: agent.error };
  return { tone: "ok", label: "在线", note: agent.error };
}

/** 需要人处理的问题数：离线/启动失败的 agent、历史读取失败、报错的供应商。 */
export function healthIssueCount(agents: AgentDescriptor[], providers: Provider[]) {
  const agentIssues = agents.filter((agent) => {
    const tone = agentHealth(agent).tone;
    return tone === "warn" || tone === "error";
  }).length;
  const providerIssues = providers.filter(
    (provider) => provider.enabled && provider.error,
  ).length;
  return agentIssues + providerIssues;
}

export function sessionHealth(threads: ThreadSummary[]) {
  let locked = 0;
  let offline = 0;
  let connected = 0;
  for (const thread of threads) {
    if (thread.locked) locked += 1;
    if (thread.status === "offline") offline += 1;
    if (thread.claudeConnected) connected += 1;
  }
  return { locked, offline, connected };
}
