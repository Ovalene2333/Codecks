import { useEffect, useRef, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { api, post } from "../api";
import { DirBrowser } from "../DirBrowser";
import { ModelPicker } from "../ModelPicker";
import { resolveNewThreadDefaults } from "../projects";
import type {
  AgentDescriptor,
  AgentProfile,
  ApprovalMode,
  ClaudePermissionMode,
  Personality,
  ProjectRecord,
  Provider,
  SandboxMode,
  Snapshot,
} from "../types";
import { Modal } from "../ui";
import {
  approvalMode,
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
} from "../codexLabels";
import { basename } from "../format";
import { isWslCwd, toggleWslCwd } from "../wsl-path";
import {
  agentProtocol,
  capabilitiesFor,
  defaultAgentId,
  isAgentEnabled,
  opencodeProviderId,
  type AgentId,
  type AgentProtocol,
} from "../agents";
import { CLAUDE_PERMISSION_OPTIONS } from "../layout/SessionToolbar";

export function NewThreadModal({
  providers,
  agents,
  agentProfiles = [],
  initialCwd = "",
  project,
  preferences,
  runtimeWsl = false,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  agents: AgentDescriptor[];
  agentProfiles?: AgentProfile[];
  initialCwd?: string;
  project?: ProjectRecord;
  preferences?: Snapshot["preferences"];
  runtimeWsl?: boolean;
  onClose: () => void;
  onCreated: (
    agentId: AgentId,
    providerId: string,
    id: string,
    thread: any,
  ) => void;
}) {
  const defaults = resolveNewThreadDefaults({
    cwd: initialCwd,
    project,
    preferences,
    providers,
    runtimeWsl,
  });
  const preferredAgentId = defaultAgentId(
    agents,
    project?.defaults?.agentId || preferences?.lastAgentId,
  );
  // 已停用的 agent 不能新建会话：选择器里直接不出现，在设置里启用后才回来。
  const enabledAgents = agents.filter(isAgentEnabled);
  const agentOptions: Pick<
    AgentDescriptor,
    "id" | "name" | "online" | "starting" | "protocol" | "fallbackFor"
  >[] = enabledAgents.length
    ? enabledAgents
    : [
        {
          id: "codex",
          name: "Codex",
          protocol: "native",
          online: true,
          starting: false,
        },
      ];
  const nativeAgents = agentOptions.filter(
    (agent) => agentProtocol(agent) === "native",
  );
  const acpAgents = agentOptions.filter(
    (agent) => agentProtocol(agent) === "acp",
  );
  const [agentId, setAgentId] = useState<AgentId>(preferredAgentId);
  const [protocolTab, setProtocolTab] = useState<AgentProtocol>(() => {
    const preferred = agentOptions.find(
      (agent) => agent.id === preferredAgentId,
    );
    return preferred ? agentProtocol(preferred) : "native";
  });
  const listedAgents = acpAgents.length
    ? protocolTab === "acp"
      ? acpAgents
      : nativeAgents
    : agentOptions;
  // 快照的 agentProfiles 已汇总各 adapter 的 publicProfiles（ACP 的
  // `${id}-current` 占位也在其中）：先按它渲染最终形态，再后台静默校验，
  // 否则每个弹窗都要等一次 /profiles 往返才出现最终界面。
  const profilesFor = (id: AgentId) =>
    agentProfiles.filter((profile) => profile.agentId === id);
  const preferredProfile = (list: AgentProfile[]) =>
    list.find((profile) => profile.current && profile.enabled !== false) ||
    list.find((profile) => profile.enabled !== false);
  // 服务端把 `${id}-current` 视作「当前配置档」占位；opencode 的 providerId
  // 由模型 id 携带，留空沿用旧行为。
  const placeholderProviderId = (id: AgentId) =>
    id === "opencode" ? "" : `${id}-current`;
  const seedProviderId = (id: AgentId) =>
    preferredProfile(profilesFor(id))?.id || placeholderProviderId(id);
  const [refreshedProfiles, setRefreshedProfiles] = useState<
    Record<string, AgentProfile[]>
  >({});
  const profiles =
    agentId === "codex"
      ? []
      : (refreshedProfiles[agentId] ?? profilesFor(agentId));
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [form, setForm] = useState(() => ({
    ...defaults,
    providerId:
      preferredAgentId === "codex"
        ? defaults.providerId
        : seedProviderId(preferredAgentId),
    model: preferredAgentId === "codex" ? defaults.model : "default",
    reasoningEffort:
      preferredAgentId === "codex" ? defaults.reasoningEffort : "",
    name: "",
    personality: "" as "" | Personality,
  }));
  const [emptyWslPathMode, setEmptyWslPathMode] = useState(runtimeWsl);
  const wslPathMode = form.cwd.trim() ? isWslCwd(form.cwd) : emptyWslPathMode;
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    if (agentId === "codex") {
      setProfilesLoading(false);
      return;
    }
    let cancelled = false;
    const hasSeed = profilesFor(agentId).length > 0;
    // 没有种子才露出「正在读取…」；有种子时表单已可用，静默校验即可。
    // 显式赋终值：切到有种子 agent 时要清掉上一个 agent 留下的 loading。
    setProfilesLoading(!hasSeed);
    api<{ profiles: AgentProfile[] }>(`/agents/${agentId}/profiles`)
      .then((result) => {
        if (cancelled) return;
        setRefreshedProfiles((current) => ({
          ...current,
          [agentId]: result.profiles,
        }));
        setForm((current) => {
          // 已选配置档（含刚手选的）在新列表里仍有效就保留。
          if (result.profiles.some((p) => p.id === current.providerId))
            return current;
          return {
            ...current,
            providerId:
              preferredProfile(result.profiles)?.id ||
              placeholderProviderId(agentId),
          };
        });
      })
      .catch((err: any) => {
        if (!cancelled && !hasSeed) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setProfilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const selectProtocol = (next: AgentProtocol) => {
    setProtocolTab(next);
    const group = next === "acp" ? acpAgents : nativeAgents;
    if (group.some((agent) => agent.id === agentId)) return;
    const pick =
      group.find((agent) => agent.online) ||
      group.find((agent) => agent.starting) ||
      group[0];
    if (pick) selectAgent(pick.id);
  };
  const selectAgent = (next: AgentId) => {
    setAgentId(next);
    setError("");
    if (next === "codex")
      // 切回 Codex 时丢掉 Claude/OpenCode 留下的 "default" 占位，用 Codex 默认链重算。
      setForm((current) => ({
        ...current,
        providerId: defaults.providerId,
        model: defaults.model,
        reasoningEffort: defaults.reasoningEffort,
      }));
    else
      setForm((current) => ({
        ...current,
        providerId: seedProviderId(next),
        model: "default",
        reasoningEffort: "",
      }));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      // Codex 的空/"default" 都视同未指定：让后端用供应商默认，而不是把字面量发给 runtime。
      const codexModel =
        agentId === "codex"
          ? form.model.trim() === "" || form.model.trim() === "default"
            ? undefined
            : form.model.trim()
          : form.model;
      const payload = {
        ...form,
        model: codexModel,
        providerId: form.providerId || undefined,
        ...(agentId === "codex"
          ? { permissionMode: undefined }
          : {
              // 非 Codex agent 不使用 codex 的权限/沙箱/personality 字段。
              reasoningEffort:
                agentId === "claude"
                  ? undefined
                  : form.reasoningEffort || undefined,
              personality: undefined,
              sandbox: undefined,
              approvalPolicy: undefined,
              approvalsReviewer: undefined,
              ...(agentId === "claude" ? {} : { permissionMode: undefined }),
            }),
        personality: form.personality || undefined,
      };
      const thread = await post(`/agents/${agentId}/threads`, payload);
      onCreated(agentId, thread.providerId, thread.id, thread);
      onClose();
    } catch (err: any) {
      setError(err.message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title={
        initialCwd ? `在 ${basename(initialCwd)} 中新建会话` : "启动新会话"
      }
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <form className="form" onSubmit={submit}>
        <label>
          Agent
          {acpAgents.length ? (
            <div
              className="library-segment"
              role="tablist"
              aria-label="启动方式"
            >
              <button
                type="button"
                role="tab"
                className={protocolTab === "native" ? "on" : ""}
                aria-selected={protocolTab === "native"}
                onClick={() => selectProtocol("native")}
              >
                原生
              </button>
              <button
                type="button"
                role="tab"
                className={protocolTab === "acp" ? "on" : ""}
                aria-selected={protocolTab === "acp"}
                onClick={() => selectProtocol("acp")}
              >
                ACP
              </button>
            </div>
          ) : null}
          <select
            value={agentId}
            onChange={(event) => selectAgent(event.target.value as AgentId)}
          >
            {listedAgents.map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={!agent.online && !agent.starting}
              >
                {agent.name}
                {agent.fallbackFor ? "（备选）" : ""}
                {!agent.online
                  ? agent.starting
                    ? "（启动中）"
                    : "（离线）"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {agentId === "codex" ? (
          <>
            <label>
              供应商
              <select
                value={form.providerId}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    providerId: e.target.value,
                    // 换供应商时顺手丢掉占位，避免目录卡住时误提交。
                    ...(current.model.trim() === "default"
                      ? { model: "" }
                      : {}),
                  }))
                }
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <ModelPicker
              providerId={form.providerId}
              model={form.model}
              reasoningEffort={form.reasoningEffort}
              onChange={(next) =>
                setForm((current) => ({ ...current, ...next }))
              }
            />
          </>
        ) : agentId === "claude" ? (
          <>
            <label>
              Claude 配置档
              <select
                value={form.providerId}
                disabled={profilesLoading || profiles.length === 0}
                onChange={(event) => {
                  const profile = profiles.find(
                    (item) => item.id === event.target.value,
                  );
                  if (profile?.official) {
                    event.currentTarget.value = form.providerId;
                    window.alert(
                      "you can't choose it because the world IS NOT Anthropic's world",
                    );
                    return;
                  }
                  if (profile?.enabled === false) {
                    setError("此 Claude 中转配置缺少 API 地址或认证凭据");
                    return;
                  }
                  setError("");
                  setForm({ ...form, providerId: event.target.value });
                }}
              >
                {profilesLoading ? (
                  <option value="">正在读取…</option>
                ) : profiles.length ? (
                  <>
                    <option value="" disabled>
                      请选择 Claude 中转配置
                    </option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.current ? "（当前）" : ""}
                        {profile.official ? "（不可用）" : ""}
                      </option>
                    ))}
                  </>
                ) : (
                  <option value="">未找到 CC Switch Claude 配置</option>
                )}
              </select>
            </label>
            <ModelPicker
              agentId="claude"
              providerId={form.providerId}
              model={form.model}
              reasoningEffort=""
              onChange={({ model }) =>
                setForm((current) => ({ ...current, model }))
              }
            />
            <label>
              Claude 权限
              <select
                value={form.permissionMode}
                onChange={(event) =>
                  setForm({
                    ...form,
                    permissionMode: event.target.value as ClaudePermissionMode,
                  })
                }
              >
                {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <ModelPicker
              agentId={agentId}
              // ACP agent 的目录能力由 descriptor 声明（spec.models 或既有
              // 会话的模型表）；没有目录就不发请求，直接手填。
              providerId={
                capabilitiesFor(agents, { agentId }).models
                  ? form.providerId
                  : ""
              }
              cwd={form.cwd}
              model={form.model}
              reasoningEffort={form.reasoningEffort}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  model: next.model,
                  reasoningEffort: next.reasoningEffort,
                  ...(agentId === "opencode" && opencodeProviderId(next.model)
                    ? // The model id carries the provider, so the thread keeps
                      // pointing at the right one without a second picker.
                      { providerId: opencodeProviderId(next.model) }
                    : {}),
                }))
              }
            />
            {agentId === "opencode" ? null : profilesLoading ||
              profiles.length > 1 ? (
              <label>
                配置档
                <select
                  value={form.providerId}
                  disabled={profilesLoading}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      providerId: event.target.value,
                    }))
                  }
                >
                  {profilesLoading ? (
                    <option value="">正在读取…</option>
                  ) : (
                    profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.current ? "（当前）" : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : null}
          </>
        )}
        <label>
          工作目录
          <div className="input-action">
            <input
              required
              value={form.cwd}
              onChange={(e) => {
                const cwd = e.target.value;
                setForm({ ...form, cwd });
              }}
              placeholder={
                runtimeWsl
                  ? "/home/you/project 或 /mnt/d/Code/project"
                  : "D:\\Code\\project 或 /mnt/d/Code/project"
              }
            />
            {runtimeWsl ? (
              <button
                type="button"
                className={`wsl-cwd-btn${wslPathMode ? " is-wsl" : ""}`}
                aria-pressed={wslPathMode}
                title={
                  !form.cwd.trim()
                    ? wslPathMode
                      ? "WSL 路径模式已启用"
                      : "切换为 WSL 路径"
                    : isWslCwd(form.cwd)
                      ? toggleWslCwd(form.cwd) === form.cwd.trim()
                        ? "此目录只在 WSL 中，无法切回 Windows"
                        : "切换为 Windows 目录"
                      : "切换为 WSL 目录"
                }
                disabled={
                  Boolean(form.cwd.trim()) &&
                  toggleWslCwd(form.cwd) === form.cwd.trim()
                }
                onClick={() => {
                  if (!form.cwd.trim()) {
                    setEmptyWslPathMode((current) => !current);
                    return;
                  }
                  const cwd = toggleWslCwd(form.cwd);
                  setForm((current) => ({ ...current, cwd }));
                }}
              >
                WSL
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              title="浏览目录"
              onClick={() => setBrowse(true)}
            >
              <FolderOpen />
            </button>
          </div>
        </label>
        <label>
          会话名称（可选）
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="修复登录问题"
          />
        </label>
        {agentId === "codex" && (
          <>
            <div className="form-grid">
              <label>
                Sandbox
                <select
                  value={form.sandbox}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      ...settingsForSandboxMode(
                        e.target.value as SandboxMode,
                        approvalMode(
                          form.approvalPolicy,
                          form.approvalsReviewer,
                        ),
                      ),
                    })
                  }
                >
                  {SANDBOX_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Approvals
                <select
                  value={approvalMode(
                    form.approvalPolicy,
                    form.approvalsReviewer,
                  )}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      ...settingsForApprovalMode(
                        e.target.value as ApprovalMode,
                        form.sandbox,
                      ),
                    })
                  }
                >
                  {APPROVAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Personality
              <select
                value={form.personality}
                onChange={(e) =>
                  setForm({
                    ...form,
                    personality: e.target.value as "" | Personality,
                  })
                }
              >
                <option value="">Default</option>
                <option value="pragmatic">Pragmatic</option>
                <option value="friendly">Friendly</option>
                <option value="none">None</option>
              </select>
            </label>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <button
          className="primary"
          type="submit"
          disabled={
            submitting ||
            !form.providerId ||
            profilesLoading ||
            !listedAgents.some((agent) => agent.id === agentId)
          }
        >
          <Sparkles />
          {submitting ? "正在创建…" : "创建会话"}
        </button>
      </form>
      {browse && (
        <DirBrowser
          initialPath={form.cwd || preferences?.recentDirs?.[0]}
          onClose={() => setBrowse(false)}
          onSelect={(cwd) => {
            setForm((current) => ({ ...current, cwd }));
            setBrowse(false);
          }}
        />
      )}
    </Modal>
  );
}
