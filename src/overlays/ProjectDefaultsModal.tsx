import { useState } from "react";
import { defaultAgentId, isAgentEnabled } from "../agents";
import { ModelPicker } from "../ModelPicker";
import type {
  AgentDescriptor,
  ApprovalMode,
  ClaudePermissionMode,
  DeckPreferences,
  ProjectDefaults,
  ProjectRecord,
  Provider,
  SandboxMode,
} from "../types";
import {
  approvalMode,
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
} from "../codexLabels";
import { CLAUDE_PERMISSION_OPTIONS } from "../layout/SessionToolbar";
import { Button, Field, Group, Section, Seg } from "../kit";
import { Modal } from "../ui";
import { OpenCodeAgentsSection } from "./OpenCodeAgentsSection";

export type ProjectDefaultsSave = Omit<
  ProjectDefaults,
  "requestMaxRetries" | "streamMaxRetries" | "streamIdleTimeoutMs"
> & {
  requestMaxRetries?: number | null;
  streamMaxRetries?: number | null;
  streamIdleTimeoutMs?: number | null;
};

type ProjectTab = "general" | "opencode";

function parseOptionalInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function initialProjectDefaults(
  project: ProjectRecord,
  agents: AgentDescriptor[],
  preferences?: DeckPreferences,
): ProjectDefaults {
  const current = project.defaults || {};
  const hasApprovalDefaults = Boolean(
    current.approvalPolicy || current.approvalsReviewer,
  );
  const sandbox = current.sandbox || "workspace-write";
  return {
    ...current,
    agentId: current.agentId || defaultAgentId(agents, preferences?.lastAgentId),
    permissionMode:
      current.permissionMode || preferences?.lastPermissionMode || "default",
    sandbox,
    ...(hasApprovalDefaults
      ? {
          approvalPolicy: current.approvalPolicy || "on-request",
          approvalsReviewer: current.approvalsReviewer || "user",
        }
      : sandbox === "danger-full-access"
        ? { approvalPolicy: "never", approvalsReviewer: "user" }
        : { approvalPolicy: "on-request", approvalsReviewer: "auto_review" }),
  };
}

/**
 * 项目设置：显示名称 + 在此目录新建会话的默认值（「常规」），以及写入
 * 项目 opencode.json 的代理配置（「OpenCode」）。两者落在不同的地方，
 * 分成两个标签、各自保存，不再一个弹窗里两颗意义不同的保存按钮。
 */
export function ProjectDefaultsModal({
  project,
  agents,
  providers,
  preferences,
  onClose,
  onSave,
}: {
  project: ProjectRecord;
  agents: AgentDescriptor[];
  providers: Provider[];
  preferences?: DeckPreferences;
  onClose: () => void;
  onSave: (defaults: ProjectDefaultsSave, name?: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<ProjectTab>("general");
  // 打开过 OpenCode 标签后保持挂载：切回「常规」再切回来，草稿还在。
  const [opencodeVisited, setOpencodeVisited] = useState(false);
  const [name, setName] = useState(project.name || "");
  const [defaults, setDefaults] = useState<ProjectDefaults>(() =>
    initialProjectDefaults(project, agents, preferences),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const enabledAgents = agents.filter(isAgentEnabled);
  const agentOptions = enabledAgents.length
    ? enabledAgents
    : agents.filter((agent) => agent.id === "codex");
  const opencode = agents.find((agent) => agent.id === "opencode");
  const patch = (next: Partial<ProjectDefaults>) =>
    setDefaults((current) => ({ ...current, ...next }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave(
        {
          agentId: defaults.agentId,
          providerId: defaults.providerId,
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort,
          sandbox: defaults.sandbox,
          approvalPolicy: defaults.approvalPolicy,
          approvalsReviewer: defaults.approvalsReviewer,
          permissionMode: defaults.permissionMode,
          requestMaxRetries: defaults.requestMaxRetries ?? null,
          streamMaxRetries: defaults.streamMaxRetries ?? null,
          streamIdleTimeoutMs: defaults.streamIdleTimeoutMs ?? null,
        },
        name.trim() || undefined,
      );
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      className="ui-panel project-settings-modal"
      title={`项目设置 · ${project.name || project.cwd}`}
      onClose={onClose}
    >
      {opencode ? (
        <div className="ui-panel__tabs">
          <Seg<ProjectTab>
            items={[
              { value: "general", label: "常规" },
              { value: "opencode", label: "OpenCode" },
            ]}
            value={tab}
            onChange={(next) => {
              setTab(next);
              if (next === "opencode") setOpencodeVisited(true);
            }}
            label="项目设置分类"
            idPrefix="project-settings"
          />
        </div>
      ) : null}
      <div
        className="ui-panel__body"
        role={opencode ? "tabpanel" : undefined}
        id={opencode ? "project-settings-panel" : undefined}
        aria-labelledby={opencode ? `project-settings-tab-${tab}` : undefined}
      >
        <form
          className="ui-form"
          hidden={tab !== "general"}
          onSubmit={submit}
        >
          <Section title="项目">
            <Group pad>
              <Field label="显示名称" hint={<code>{project.cwd}</code>}>
                <input
                  className="ui-input"
                  value={name}
                  placeholder={project.cwd.split(/[\\/]/).filter(Boolean).at(-1)}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </Group>
          </Section>
          <Section
            title="新会话默认值"
            desc="在此目录新建会话时预填，优先于全局默认值。"
          >
            <Group pad>
              <Field label="默认 Agent">
                <select
                  className="ui-input"
                  value={defaults.agentId}
                  onChange={(event) => patch({ agentId: event.target.value })}
                >
                  {agentOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </Field>
            </Group>
            <h4 className="ui-subhead">Codex</h4>
            <Group pad>
              <Field label="供应商">
                <select
                  className="ui-input"
                  value={defaults.providerId || ""}
                  onChange={(event) =>
                    patch({ providerId: event.target.value || undefined })
                  }
                >
                  <option value="">沿用全局默认</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="ui-form__grid ui-form-compat">
                <ModelPicker
                  providerId={defaults.providerId || providers[0]?.id || ""}
                  model={defaults.model || ""}
                  reasoningEffort={defaults.reasoningEffort || ""}
                  onChange={(next) => patch(next)}
                />
              </div>
              <div className="ui-form__grid">
                <Field label="沙箱">
                  <select
                    className="ui-input"
                    value={defaults.sandbox || "workspace-write"}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        ...settingsForSandboxMode(
                          event.target.value as SandboxMode,
                          approvalMode(
                            current.approvalPolicy,
                            current.approvalsReviewer,
                          ),
                        ),
                      }))
                    }
                  >
                    {SANDBOX_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="审批">
                  <select
                    className="ui-input"
                    value={approvalMode(
                      defaults.approvalPolicy,
                      defaults.approvalsReviewer,
                    )}
                    onChange={(event) =>
                      setDefaults((current) => ({
                        ...current,
                        ...settingsForApprovalMode(
                          event.target.value as ApprovalMode,
                          current.sandbox || "workspace-write",
                        ),
                      }))
                    }
                  >
                    {APPROVAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Group>
            <h4 className="ui-subhead">Claude Code</h4>
            <Group pad>
              <Field label="权限模式">
                <select
                  className="ui-input"
                  value={defaults.permissionMode || "default"}
                  onChange={(event) =>
                    patch({
                      permissionMode: event.target
                        .value as ClaudePermissionMode,
                    })
                  }
                >
                  {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </Group>
          </Section>
          <Section
            title="Codex 连接"
            desc="写入共享 Runtime。留空使用默认值；有会话运行时先记录，空闲后应用。"
          >
            <Group pad>
              <div className="ui-form__grid ui-form__grid--3">
                <Field label="请求重试">
                  <input
                    className="ui-input"
                    type="number"
                    min={0}
                    max={100}
                    inputMode="numeric"
                    placeholder="默认 4"
                    value={defaults.requestMaxRetries ?? ""}
                    onChange={(event) =>
                      patch({
                        requestMaxRetries: parseOptionalInt(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="流重试">
                  <input
                    className="ui-input"
                    type="number"
                    min={0}
                    max={100}
                    inputMode="numeric"
                    placeholder="默认 5"
                    value={defaults.streamMaxRetries ?? ""}
                    onChange={(event) =>
                      patch({
                        streamMaxRetries: parseOptionalInt(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="空闲超时（毫秒）">
                  <input
                    className="ui-input"
                    type="number"
                    min={1000}
                    max={3600000}
                    step={1000}
                    inputMode="numeric"
                    placeholder="默认 300000"
                    value={defaults.streamIdleTimeoutMs ?? ""}
                    onChange={(event) =>
                      patch({
                        streamIdleTimeoutMs: parseOptionalInt(
                          event.target.value,
                        ),
                      })
                    }
                  />
                </Field>
              </div>
            </Group>
          </Section>
          {error && <p className="ui-error">{error}</p>}
          <div className="ui-actions">
            <Button onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" busy={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
        {opencode && opencodeVisited ? (
          <div hidden={tab !== "opencode"}>
            <OpenCodeAgentsSection
              cwd={project.cwd}
              enabled={isAgentEnabled(opencode)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
