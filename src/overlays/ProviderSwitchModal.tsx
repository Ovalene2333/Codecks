import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { api, post } from "../api";
import { threadPath } from "../agents";
import { threadIsUnsent } from "../format";
import { ModelPicker } from "../ModelPicker";
import type { AgentProfile, Provider, ThreadSummary } from "../types";
import { Modal } from "../ui";

export function ProviderSwitchModal({
  thread,
  providers,
  agentProfiles,
  onClose,
  onCreated,
}: {
  thread: ThreadSummary;
  providers: Provider[];
  agentProfiles: AgentProfile[];
  onClose: () => void;
  onCreated: (providerId: string, threadId: string) => void;
}) {
  const isClaude = thread.agentId === "claude";
  const choices = isClaude
    ? agentProfiles.filter(
        (profile) =>
          profile.agentId === "claude" &&
          profile.id !== thread.providerId &&
          profile.enabled !== false &&
          !profile.official,
      )
    : providers.filter((provider) => provider.id !== thread.providerId);
  const [targetProviderId, setTargetProviderId] = useState(
    choices[0]?.id || "",
  );
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState(
    thread.reasoningEffort || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unsent = threadIsUnsent(thread);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !targetProviderId) return;
    setBusy(true);
    setError("");
    try {
      if (isClaude) {
        await api(threadPath(thread), {
          method: "PATCH",
          body: JSON.stringify({ settings: { providerId: targetProviderId } }),
        });
        onCreated(targetProviderId, thread.id);
      } else {
        const created = await post(
          `/threads/${thread.providerId}/${thread.id}/migrate`,
          {
            targetProviderId,
            model: model || undefined,
            reasoningEffort: reasoningEffort || undefined,
          },
        );
        onCreated(targetProviderId, created.id);
      }
      onClose();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="切换此 Session 的供应商" onClose={() => !busy && onClose()}>
      <form className="form" onSubmit={submit}>
        <div className="migration-note">
          <ArrowRightLeft />
          <div>
            <b>
              {isClaude
                ? "从下一轮开始使用新中转"
                : unsent
                  ? "直接切换到目标供应商"
                  : "带完整历史创建供应商切换分支"}
            </b>
            <p>
              {isClaude
                ? "Claude 会保留当前 Session ID 和完整历史；切换只修改此会话的 relay 绑定，不会更改 CC Switch 当前项。"
                : unsent
                  ? "此会话还没有发送过消息，没有可 fork 的历史。切换后会在目标供应商下沿用当前项目目录和会话设置。"
                  : "Codex 会 fork 当前 Session 的完整历史，并让新分支使用目标供应商；原分支保留，运行中或待审批时不能切换。"}
            </p>
          </div>
        </div>
        <label>
          {isClaude ? "目标 Claude 配置档" : "目标供应商"}
          <select
            value={targetProviderId}
            onChange={(e) => setTargetProviderId(e.target.value)}
            disabled={choices.length === 0}
          >
            {choices.length === 0 && <option value="">没有其他可用配置</option>}
            {choices.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        {!isClaude && targetProviderId && (
          <ModelPicker
            providerId={targetProviderId}
            model={model}
            reasoningEffort={reasoningEffort}
            onChange={(next) => {
              setModel(next.model);
              setReasoningEffort(next.reasoningEffort);
            }}
          />
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy || !targetProviderId}>
          <ArrowRightLeft />
          {busy
            ? isClaude
              ? "正在切换…"
              : unsent
                ? "正在切换…"
                : "正在创建分支…"
            : isClaude
              ? "切换配置档"
              : unsent
                ? "直接切换"
                : "创建切换分支"}
        </button>
      </form>
    </Modal>
  );
}
