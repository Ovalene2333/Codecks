import { useRef, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { post } from "../api";
import { DirBrowser } from "../DirBrowser";
import { ModelPicker } from "../ModelPicker";
import { resolveNewThreadDefaults } from "../projects";
import type {
  ApprovalPolicy,
  Personality,
  ProjectRecord,
  Provider,
  SandboxMode,
  Snapshot,
} from "../types";
import { Modal } from "../ui";
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from "../codexLabels";
import { basename } from "../format";
import { isWslCwd, toggleWslCwd } from "../wsl-path";

export function NewThreadModal({
  providers,
  initialCwd = "",
  project,
  preferences,
  runtimeWsl = false,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  initialCwd?: string;
  project?: ProjectRecord;
  preferences?: Snapshot["preferences"];
  runtimeWsl?: boolean;
  onClose: () => void;
  onCreated: (p: string, id: string) => void;
}) {
  const defaults = resolveNewThreadDefaults({
    cwd: initialCwd,
    project,
    preferences,
    providers,
  });
  const [form, setForm] = useState({
    ...defaults,
    name: "",
    personality: "" as "" | Personality,
  });
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        ...form,
        personality: form.personality || undefined,
      };
      const thread = await post("/threads", payload);
      onCreated(form.providerId, thread.id);
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
          供应商
          <select
            value={form.providerId}
            onChange={(e) => setForm({ ...form, providerId: e.target.value })}
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
          onChange={(next) => setForm((current) => ({ ...current, ...next }))}
        />
        <label>
          工作目录
          <div className="input-action">
            <input
              required
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              placeholder={
                runtimeWsl
                  ? "/home/you/project 或 /mnt/d/Code/project"
                  : "D:\\Code\\project 或 /mnt/d/Code/project"
              }
            />
            {runtimeWsl ? (
              <button
                type="button"
                className={`wsl-cwd-btn${isWslCwd(form.cwd) ? " is-wsl" : ""}`}
                aria-pressed={isWslCwd(form.cwd)}
                title={
                  !form.cwd.trim()
                    ? "先填写工作目录"
                    : isWslCwd(form.cwd)
                      ? toggleWslCwd(form.cwd) === form.cwd.trim()
                        ? "此目录只在 WSL 中，无法切回 Windows"
                        : "切换为 Windows 目录"
                      : "切换为 WSL 目录"
                }
                disabled={
                  !form.cwd.trim() ||
                  toggleWslCwd(form.cwd) === form.cwd.trim()
                }
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    cwd: toggleWslCwd(current.cwd),
                  }))
                }
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
        <div className="form-grid">
          <label>
            Sandbox
            <select
              value={form.sandbox}
              onChange={(e) =>
                setForm({ ...form, sandbox: e.target.value as SandboxMode })
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
              value={form.approvalPolicy}
              onChange={(e) =>
                setForm({
                  ...form,
                  approvalPolicy: e.target.value as ApprovalPolicy,
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
        {error && <p className="error-text">{error}</p>}
        <button
          className="primary"
          type="submit"
          disabled={submitting || !form.providerId}
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
