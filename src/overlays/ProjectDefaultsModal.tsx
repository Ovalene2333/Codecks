import { useState } from "react";
import { ModelPicker } from "../ModelPicker";
import type {
  ApprovalPolicy,
  ProjectDefaults,
  ProjectRecord,
  Provider,
  SandboxMode,
} from "../types";
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from "../codexLabels";
import { Modal } from "../ui";

export function ProjectDefaultsModal({
  project,
  providers,
  onClose,
  onSave,
}: {
  project: ProjectRecord;
  providers: Provider[];
  onClose: () => void;
  onSave: (defaults: ProjectDefaults, name?: string) => Promise<void>;
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
            await onSave(defaults, name.trim() || undefined);
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
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit">
          保存默认设置
        </button>
      </form>
    </Modal>
  );
}
