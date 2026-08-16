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
import { defaultAgentId } from "../agents";
import { CLAUDE_PERMISSION_OPTIONS } from "../layout/SessionToolbar";

export function NewThreadModal({
  providers,
  agents,
  initialCwd = "",
  project,
  preferences,
  runtimeWsl = false,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  agents: AgentDescriptor[];
  initialCwd?: string;
  project?: ProjectRecord;
  preferences?: Snapshot["preferences"];
  runtimeWsl?: boolean;
  onClose: () => void;
  onCreated: (
    agentId: "codex" | "claude",
    providerId: string,
    id: string,
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
  const [agentId, setAgentId] = useState<"codex" | "claude">(preferredAgentId);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [form, setForm] = useState({
    ...defaults,
    name: "",
    personality: "" as "" | Personality,
  });
  const [emptyWslPathMode, setEmptyWslPathMode] = useState(runtimeWsl);
  const wslPathMode = form.cwd.trim() ? isWslCwd(form.cwd) : emptyWslPathMode;
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    if (agentId === "codex") {
      setProfiles([]);
      return;
    }
    let cancelled = false;
    setProfilesLoading(true);
    api<{ profiles: AgentProfile[] }>(`/agents/${agentId}/profiles`)
      .then((result) => {
        if (cancelled) return;
        setProfiles(result.profiles);
        const preferred = result.profiles.find(
          (profile) => profile.current && profile.enabled !== false,
        );
        const firstEnabled = result.profiles.find(
          (profile) => profile.enabled !== false,
        );
        setForm((current) => ({
          ...current,
          providerId: preferred?.id || firstEnabled?.id || "",
          model: "default",
        }));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setProfilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const selectAgent = (next: "codex" | "claude") => {
    setAgentId(next);
    setError("");
    if (next === "codex")
      setForm((current) => ({ ...current, providerId: defaults.providerId }));
    else
      setForm((current) => ({
        ...current,
        providerId: "",
        model: "default",
      }));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        ...form,
        providerId: form.providerId || undefined,
        ...(agentId === "claude"
          ? {
              reasoningEffort: undefined,
              personality: undefined,
              sandbox: undefined,
              approvalPolicy: undefined,
              approvalsReviewer: undefined,
            }
          : { permissionMode: undefined }),
        personality: form.personality || undefined,
      };
      const thread = await post(`/agents/${agentId}/threads`, payload);
      onCreated(agentId, thread.providerId, thread.id);
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
          <select
            value={agentId}
            onChange={(event) =>
              selectAgent(event.target.value as "codex" | "claude")
            }
          >
            {(agents.length
              ? agents
              : [
                  {
                    id: "codex" as const,
                    name: "Codex",
                    online: true,
                    starting: false,
                  },
                ]
            ).map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={!agent.online && !agent.starting}
              >
                {agent.name}
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
                  setForm({ ...form, providerId: e.target.value })
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
        ) : (
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
          disabled={submitting || !form.providerId || profilesLoading}
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
