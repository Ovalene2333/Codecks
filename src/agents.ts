import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentProfile,
  Approval,
  Provider,
  ThreadSummary,
} from "./types";

export type AgentId = "codex" | "claude";

const CODEX_CAPABILITIES: AgentCapabilities = {
  approvals: true,
  archive: true,
  delete: true,
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
          delete: false,
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

export function providerForThread(
  providers: Provider[],
  agentProfiles: AgentProfile[] | undefined,
  thread: Pick<ThreadSummary, "agentId" | "providerId">,
) {
  if (agentIdFor(thread) !== "claude")
    return providers.find((provider) => provider.id === thread.providerId);
  const profiles = (agentProfiles || []).filter(
    (profile) => profile.agentId === "claude",
  );
  return (
    profiles.find((profile) => profile.id === thread.providerId) ||
    (thread.providerId === "claude-current"
      ? profiles.find((profile) => profile.current && profile.enabled !== false)
      : undefined)
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
