import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentProfile,
  Approval,
  Provider,
  ThreadSummary,
} from "./types";

export type AgentId = "codex" | "claude" | "opencode";

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
    (id === "claude" ? "Claude Code" : id === "opencode" ? "OpenCode" : "Codex")
  );
}

export function providerForThread(
  providers: Provider[],
  agentProfiles: AgentProfile[] | undefined,
  thread: Pick<
    ThreadSummary,
    "agentId" | "providerId" | "model" | "resolvedModel"
  >,
) {
  if (agentIdFor(thread) === "codex")
    return providers.find((provider) => provider.id === thread.providerId);
  const profiles = (agentProfiles || []).filter(
    (profile) => profile.agentId === agentIdFor(thread),
  );
  // OpenCode model ids carry their provider, so the model a thread runs on is
  // the truth even when the stored providerId predates a model switch.
  if (agentIdFor(thread) === "opencode") {
    const fromModel = opencodeProviderId(
      (thread as { resolvedModel?: string }).resolvedModel || thread.model,
    );
    if (fromModel)
      return (
        profiles.find((profile) => profile.id === fromModel) ||
        profiles.find((profile) => profile.id === thread.providerId)
      );
  }
  return (
    profiles.find((profile) => profile.id === thread.providerId) ||
    (thread.providerId === "claude-current"
      ? profiles.find((profile) => profile.current && profile.enabled !== false)
      : profiles.find((profile) => profile.id === thread.providerId))
  );
}

/**
 * OpenCode model ids are `providerID/modelID`, so the provider a thread runs
 * on is implied by its model. Returns "" for placeholders like `default`.
 */
export function opencodeProviderId(model?: string) {
  const separator = (model || "").indexOf("/");
  return separator > 0 ? model!.slice(0, separator) : "";
}

export function threadPath(thread: Pick<ThreadSummary, "id" | "agentId">) {
  return `/agents/${agentIdFor(thread)}/threads/${encodeURIComponent(thread.id)}`;
}

/**
 * 归档/恢复路径：Codex 沿用旧 manager 路由，其它 Agent 走通用 Agent API
 *（`POST /api/agents/:agentId/threads/:threadId/archive|unarchive`）。
 */
export function threadArchivePath(
  thread: Pick<ThreadSummary, "id" | "agentId" | "providerId">,
  action: "archive" | "unarchive",
) {
  return agentIdFor(thread) === "codex"
    ? `/threads/${thread.providerId}/${thread.id}/${action}`
    : `${threadPath(thread)}/${action}`;
}

/** 删除路径：同上，Codex 走旧路由，其它 Agent 走通用删除接口。 */
export function threadRemovePath(
  thread: Pick<ThreadSummary, "id" | "agentId" | "providerId">,
) {
  return agentIdFor(thread) === "codex"
    ? `/threads/${thread.providerId}/${thread.id}`
    : threadPath(thread);
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
