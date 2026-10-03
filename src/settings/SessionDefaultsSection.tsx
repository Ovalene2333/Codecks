import { useEffect, useState } from "react";
import { put } from "../api";
import { defaultAgentId, isAgentEnabled } from "../agents";
import { ModelPicker } from "../ModelPicker";
import { resolveNewThreadDefaults } from "../projects";
import {
  approvalMode,
  APPROVAL_OPTIONS,
  approvalSettings,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
} from "../codexLabels";
import { CLAUDE_PERMISSION_OPTIONS } from "../layout/SessionToolbar";
import { Button, Choice, Field, Group, Section } from "../kit";
import type {
  AgentDescriptor,
  AgentId,
  ApprovalMode,
  ClaudePermissionMode,
  DeckPreferences,
  Provider,
  SandboxMode,
  Snapshot,
} from "../types";
import { useDirtyFlag } from "./dirty";

type DefaultsMode = "last" | "pinned";

interface DefaultsForm {
  mode: DefaultsMode;
  agentId: AgentId;
  providerId: string;
  model: string;
  reasoningEffort: string;
  sandbox: SandboxMode;
  /** approvalPolicy+approvalsReviewer 的合并选项，与新建/项目设置同一张表。 */
  approval: ApprovalMode;
  permissionMode: ClaudePermissionMode;
}

/**
 * 展示「当前生效的默认值」而不是裸的 last* 存储值：resolveNewThreadDefaults
 * 已叠加 last* 为空时的兜底（首选在线供应商、供应商默认模型、默认审批
 * 组合等），表单里不存在空态，保存时显式写回每一项。
 */
function deriveForm(
  agents: AgentDescriptor[],
  providers: Provider[],
  preferences?: DeckPreferences,
): DefaultsForm {
  const resolved = resolveNewThreadDefaults({ preferences, providers });
  return {
    mode: preferences?.pinDefaults ? "pinned" : "last",
    agentId: defaultAgentId(agents, preferences?.lastAgentId),
    providerId: resolved.providerId,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    sandbox: resolved.sandbox,
    approval: approvalMode(
      resolved.approvalPolicy,
      resolved.approvalsReviewer,
    ),
    permissionMode: resolved.permissionMode || "default",
  };
}

const MODE_HINT: Record<DefaultsMode, string> = {
  last: "每次新建时记录所选并用于下次预填；各项目同时记录其首次使用的设置。此处的修改可能在下次新建后被覆盖。",
  pinned:
    "新建时始终预填此处设置，新建会话不回写；项目的默认值仍然优先。",
};

/**
 * 新会话默认值：新建会话弹窗的初始选择（对应服务端的 last* 偏好）。
 * 「沿用上次」时 last* 会随每次新建变化；「固定」时服务端不再回写。
 */
export function SessionDefaultsSection({
  agents,
  providers,
  preferences,
  onSaved,
  onToast,
}: {
  agents: AgentDescriptor[];
  providers: Provider[];
  preferences?: DeckPreferences;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
}) {
  const [form, setForm] = useState<DefaultsForm>(() =>
    deriveForm(agents, providers, preferences),
  );
  const [baseline, setBaseline] = useState<DefaultsForm>(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useDirtyFlag("session:defaults", dirty);
  // 「沿用上次」下别处新建会话会改 last*：没在编辑时跟着快照刷新，
  // 免得表单显示的是打开设置那一刻的旧值。
  useEffect(() => {
    if (dirty || saving) return;
    const next = deriveForm(agents, providers, preferences);
    if (JSON.stringify(next) === JSON.stringify(baseline)) return;
    setForm(next);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences, providers, agents]);
  const enabledAgents = agents.filter(isAgentEnabled);
  const agentOptions = enabledAgents.length
    ? enabledAgents
    : agents.filter((agent) => agent.id === "codex");
  const patch = (next: Partial<DefaultsForm>) =>
    setForm((current) => ({ ...current, ...next }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const approval = approvalSettings(form.approval);
      const snapshot = await put<Snapshot>("/preferences", {
        pinDefaults: form.mode === "pinned",
        lastAgentId: form.agentId,
        lastProviderId: form.providerId,
        lastModel: form.model,
        lastReasoningEffort: form.reasoningEffort,
        lastSandbox: form.sandbox,
        lastApprovalPolicy: approval.approvalPolicy,
        lastApprovalsReviewer: approval.approvalsReviewer,
        lastPermissionMode: form.permissionMode,
      });
      onSaved(snapshot);
      setBaseline(form);
      onToast("新会话默认值已保存");
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="新会话默认值"
      desc="新建会话对话框的初始选择，仅影响之后新建的会话。"
    >
      <form className="ui-form" onSubmit={save}>
        <Group pad>
          <Field group label="预填方式" hint={MODE_HINT[form.mode]}>
            <Choice<DefaultsMode>
              label="预填方式"
              value={form.mode}
              onChange={(mode) => patch({ mode })}
              items={[
                { value: "last", label: "沿用上次" },
                { value: "pinned", label: "固定默认值" },
              ]}
            />
          </Field>
          <Field label="默认 Agent">
            <select
              className="ui-input"
              value={form.agentId}
              onChange={(event) =>
                patch({ agentId: event.target.value as AgentId })
              }
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
              value={form.providerId}
              onChange={(event) => patch({ providerId: event.target.value })}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="ui-form__grid ui-form-compat">
            <ModelPicker
              providerId={form.providerId}
              model={form.model}
              reasoningEffort={form.reasoningEffort}
              onChange={(next) => {
                // 模型为空时 ModelPicker 会自动填目录默认模型：这不是用户
                // 改动，同步进基线，免得一打开就显示「未保存」。
                if (!form.model && !dirty)
                  setBaseline((current) => ({ ...current, ...next }));
                patch(next);
              }}
            />
          </div>
          <div className="ui-form__grid">
            <Field label="沙箱">
              <select
                className="ui-input"
                value={form.sandbox}
                onChange={(event) =>
                  setForm((current) => {
                    const next = settingsForSandboxMode(
                      event.target.value as SandboxMode,
                      current.approval,
                    );
                    return {
                      ...current,
                      sandbox: next.sandbox,
                      approval: approvalMode(
                        next.approvalPolicy,
                        next.approvalsReviewer,
                      ),
                    };
                  })
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
                value={form.approval}
                onChange={(event) =>
                  setForm((current) => {
                    const next = settingsForApprovalMode(
                      event.target.value as ApprovalMode,
                      current.sandbox,
                    );
                    return {
                      ...current,
                      sandbox: next.sandbox,
                      approval: approvalMode(
                        next.approvalPolicy,
                        next.approvalsReviewer,
                      ),
                    };
                  })
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
              value={form.permissionMode}
              onChange={(event) =>
                patch({
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
          </Field>
        </Group>
        {error && <p className="ui-error">{error}</p>}
        <div className="ui-actions">
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setForm(baseline)}
            >
              还原
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            busy={saving}
            disabled={!dirty}
          >
            {saving ? "保存中…" : "保存默认值"}
          </Button>
        </div>
      </form>
    </Section>
  );
}
