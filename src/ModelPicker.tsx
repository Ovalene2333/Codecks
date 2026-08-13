import { useEffect, useState } from "react";
import { api } from "./api";
import type { ModelInfo } from "./types";

export function ModelPicker({
  providerId,
  model,
  reasoningEffort,
  onChange,
}: {
  providerId: string;
  model: string;
  reasoningEffort: string;
  onChange: (next: { model: string; reasoningEffort: string }) => void;
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
    api<ModelInfo[]>(`/providers/${providerId}/models`)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setManual(!list.length);
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
  }, [providerId]);

  const efforts = selected?.supportedReasoningEfforts || [];
  return (
    <>
      <label>
        模型
        {manual || !models.length ? (
          <input
            value={model}
            onChange={(e) =>
              onChange({ model: e.target.value, reasoningEffort })
            }
            placeholder={loading ? "正在读取模型目录…" : "模型 ID"}
          />
        ) : (
          <select
            value={model}
            onChange={(e) => {
              const next = models.find(
                (item) => item.model === e.target.value || item.id === e.target.value,
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
        {models.length > 0 && (
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
        <label>
          推理强度
          <select
            value={reasoningEffort}
            onChange={(e) =>
              onChange({ model, reasoningEffort: e.target.value })
            }
          >
            {efforts.map((item) => (
              <option key={item.reasoningEffort} value={item.reasoningEffort}>
                {item.reasoningEffort}
                {item.description ? ` · ${item.description}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
