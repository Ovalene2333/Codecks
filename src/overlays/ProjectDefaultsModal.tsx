import { useState } from "react";
import { ModelPicker } from "../ModelPicker";
import type {
  ApprovalPolicy,
  ProjectDefaults,
  ProjectRecord,
  Provider,
  SandboxMode,
} from "../types";

export type ProjectDefaultsSave = Omit<
  ProjectDefaults,
  "requestMaxRetries" | "streamMaxRetries" | "streamIdleTimeoutMs"
> & {
  requestMaxRetries?: number | null;
  streamMaxRetries?: number | null;
  streamIdleTimeoutMs?: number | null;
};
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from "../codexLabels";
import { Modal } from "../ui";

function parseOptionalInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
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
  const [defaults, setDefaults] = useState<ProjectDefaults>(
    project.defaults || {},
  );
  const [error, setError] = useState("");
  return (
    <Modal title={`项目设置 · ${project.name || project.cwd}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSave(
              {
                providerId: defaults.providerId,
                model: defaults.model,
                reasoningEffort: defaults.reasoningEffort,
                sandbox: defaults.sandbox,
                approvalPolicy: defaults.approvalPolicy,
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
        <label>
          显示名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
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
                  sandbox: event.target.value as SandboxMode,
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
            Approval policy
            <select
              value={defaults.approvalPolicy || "on-request"}
              onChange={(event) =>
                setDefaults((current) => ({
                  ...current,
                  approvalPolicy: event.target.value as ApprovalPolicy,
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
          写入该项目默认供应商的共享 Runtime。空着表示用 Codex 默认值。有会话在跑时会先记下，空闲后再应用。
        </p>
        <div className="form-grid">
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
        </div>
        <label>
          流空闲超时（毫秒）
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
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit">
          保存默认设置
        </button>
      </form>
    </Modal>
  );
}
