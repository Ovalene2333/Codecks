import { useState } from "react";
import { ModelPicker } from "../ModelPicker";
import type {
  ApprovalMode,
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
import { Modal } from "../ui";

export type ProjectDefaultsSave = Omit<
  ProjectDefaults,
  "requestMaxRetries" | "streamMaxRetries" | "streamIdleTimeoutMs"
> & {
  requestMaxRetries?: number | null;
  streamMaxRetries?: number | null;
  streamIdleTimeoutMs?: number | null;
};

function parseOptionalInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function initialProjectDefaults(project: ProjectRecord): ProjectDefaults {
  const current = project.defaults || {};
  const hasApprovalDefaults = Boolean(
    current.approvalPolicy || current.approvalsReviewer,
  );
  const sandbox = current.sandbox || "workspace-write";
  return {
    ...current,
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

export function ProjectDefaultsModal({
  project,
  providers,
  onClose,
  onSave,
}: {
  project: ProjectRecord;
  providers: Provider[];
  onClose: () => void;
  onSave: (defaults: ProjectDefaultsSave, name?: string) => Promise<void>;
}) {
  const [name, setName] = useState(project.name || "");
  const [defaults, setDefaults] = useState<ProjectDefaults>(() =>
    initialProjectDefaults(project),
  );
  const [error, setError] = useState("");
  return (
    <Modal
      className="project-settings-modal"
      title={`项目设置 · ${project.name || project.cwd}`}
      onClose={onClose}
    >
      <form
        className="form project-defaults-form"
        onSubmit={async (event) => {
          event.preventDefault();
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
          }
        }}
      >
        <div className="form-body">
          <label>
            显示名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            默认供应商
            <select
              value={defaults.providerId || ""}
              onChange={(event) =>
                setDefaults((current) => ({
                  ...current,
                  providerId: event.target.value || undefined,
                }))
              }
            >
              <option value="">沿用上次</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <ModelPicker
            providerId={defaults.providerId || providers[0]?.id || ""}
            model={defaults.model || ""}
            reasoningEffort={defaults.reasoningEffort || ""}
            onChange={(next) =>
              setDefaults((current) => ({ ...current, ...next }))
            }
          />
          <div className="form-grid">
            <label>
              Sandbox
              <select
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
            </label>
            <label>
              Approvals
              <select
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
            </label>
          </div>
          <p className="section-label">Codex 连接</p>
          <p className="form-hint">
            写入共享 Runtime。空着即用默认值；有会话在跑时先记下，空闲后再应用。
          </p>
          <div className="form-grid connection-grid">
            <label>
              请求重试
              <input
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                placeholder="默认 4"
                value={defaults.requestMaxRetries ?? ""}
                onChange={(event) =>
                  setDefaults((current) => ({
                    ...current,
                    requestMaxRetries: parseOptionalInt(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              流重试
              <input
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                placeholder="默认 5"
                value={defaults.streamMaxRetries ?? ""}
                onChange={(event) =>
                  setDefaults((current) => ({
                    ...current,
                    streamMaxRetries: parseOptionalInt(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              空闲超时 ms
              <input
                type="number"
                min={1000}
                max={3600000}
                step={1000}
                inputMode="numeric"
                placeholder="默认 300000"
                value={defaults.streamIdleTimeoutMs ?? ""}
                onChange={(event) =>
                  setDefaults((current) => ({
                    ...current,
                    streamIdleTimeoutMs: parseOptionalInt(event.target.value),
                  }))
                }
              />
            </label>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
