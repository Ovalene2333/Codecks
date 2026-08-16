import { useEffect, useState } from "react";
import { api } from "./api";
import { reasoningEffortLabel } from "./codexLabels";
import type { ModelInfo } from "./types";

export function ModelPicker({
  agentId = "codex",
  providerId,
  model,
  reasoningEffort,
  onChange,
  compact,
  disabled,
}: {
  agentId?: "codex" | "claude";
  providerId: string;
  model: string;
  reasoningEffort: string;
  onChange: (next: { model: string; reasoningEffort: string }) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(false);
  const selected =
    models.find((item) => item.model === model || item.id === model) ||
    models.find((item) => item.isDefault);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setLoading(true);
    const path =
      agentId === "claude"
        ? `/agents/claude/models?providerId=${encodeURIComponent(providerId)}`
        : `/providers/${providerId}/models`;
    api<ModelInfo[]>(path)
      .then((list) => {
        if (cancelled) return;
        const next = Array.isArray(list) ? list : [];
        setModels(next);
        setManual(!next.length);
        if (!model) {
          const fallback = list.find((item) => item.isDefault) || list[0];
          if (fallback)
            onChange({
              model: fallback.model,
              reasoningEffort:
                reasoningEffort || fallback.defaultReasoningEffort || "",
            });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setManual(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, providerId]);

  const efforts = selected?.supportedReasoningEfforts || [];
  return (
    <>
      <label className={compact ? "toolbar-select" : undefined}>
        {compact ? <span className="toolbar-field-label">模型</span> : "模型"}
        {manual || !models.length ? (
          <input
            value={model}
            disabled={disabled}
            aria-label="模型"
            title="模型"
            onChange={(e) =>
              onChange({ model: e.target.value, reasoningEffort })
            }
            placeholder={loading ? "正在读取模型目录…" : "模型 ID"}
          />
        ) : (
          <select
            value={model}
            disabled={disabled}
            aria-label="模型"
            title="模型"
            onChange={(e) => {
              const next = models.find(
                (item) =>
                  item.model === e.target.value || item.id === e.target.value,
              );
              onChange({
                model: e.target.value,
                reasoningEffort:
                  next?.defaultReasoningEffort ||
                  next?.supportedReasoningEfforts?.[0]?.reasoningEffort ||
                  "",
              });
            }}
          >
            {!model && <option value="">选择模型</option>}
            {models.map((item) => (
              <option key={item.id || item.model} value={item.model}>
                {item.displayName}
                {item.isDefault ? "（默认）" : ""}
              </option>
            ))}
          </select>
        )}
        {models.length > 0 && !compact && (
          <button
            type="button"
            className="text-btn"
            onClick={() => setManual((value) => !value)}
          >
            {manual ? "从目录选择" : "手动输入"}
          </button>
        )}
      </label>
      {efforts.length > 0 && (
        <label className={compact ? "toolbar-select" : undefined}>
          {compact ? (
            <span className="toolbar-field-label">推理</span>
          ) : (
            "Reasoning effort"
          )}
          <select
            value={reasoningEffort}
            disabled={disabled}
            aria-label="Reasoning effort"
            title="Reasoning effort"
            onChange={(e) =>
              onChange({ model, reasoningEffort: e.target.value })
            }
          >
            {efforts.map((item) => (
              <option
                key={item.reasoningEffort}
                value={item.reasoningEffort}
                title={item.description || undefined}
              >
                {reasoningEffortLabel(item.reasoningEffort)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
