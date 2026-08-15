import type {
  AgentCapabilities,
  AgentDescriptor,
  Approval,
  ThreadSummary,
} from "./types";

export type AgentId = "codex" | "claude";

const CODEX_CAPABILITIES: AgentCapabilities = {
  approvals: true,
  archive: true,
  fork: true,
  images: true,
  interrupt: true,
  mcp: true,
  models: true,
  review: true,
  sessionSettings: true,
  shell: true,
  skills: true,
};

export function agentIdFor(value?: { agentId?: AgentId }): AgentId {
  return value?.agentId || "codex";
}

export function defaultAgentId(
  agents: AgentDescriptor[],
  preferred?: AgentId,
): AgentId {
  if (!agents.length) return "codex";
  const preferredAgent = agents.find((agent) => agent.id === preferred);
  if (preferredAgent?.online || preferredAgent?.starting)
    return preferredAgent.id;
  return (
    agents.find((agent) => agent.online)?.id ||
    agents.find((agent) => agent.starting)?.id ||
    preferred ||
    "codex"
  );
}

export function capabilitiesFor(
  agents: AgentDescriptor[] | undefined,
  value?: { agentId?: AgentId },
) {
  const id = agentIdFor(value);
  return (
    agents?.find((agent) => agent.id === id)?.capabilities ||
    (id === "codex"
      ? CODEX_CAPABILITIES
      : {
          ...CODEX_CAPABILITIES,
          archive: false,
          fork: false,
          mcp: false,
          models: false,
          review: false,
          sessionSettings: false,
          shell: false,
          skills: false,
        })
  );
}

export function agentName(
  agents: AgentDescriptor[] | undefined,
  value?: { agentId?: AgentId },
) {
  const id = agentIdFor(value);
  return (
    agents?.find((agent) => agent.id === id)?.name ||
    (id === "claude" ? "Claude Code" : "Codex")
  );
}

export function threadPath(thread: Pick<ThreadSummary, "id" | "agentId">) {
  return `/agents/${agentIdFor(thread)}/threads/${encodeURIComponent(thread.id)}`;
}

export function threadActionPath(
  thread: Pick<ThreadSummary, "id" | "agentId">,
  action: "turns" | "interrupt",
) {
  return `${threadPath(thread)}/${action}`;
}

export function approvalPath(approval: Pick<Approval, "id" | "agentId">) {
  return `/agents/${agentIdFor(approval)}/approvals/${encodeURIComponent(approval.id)}`;
}
