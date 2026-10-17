import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { api, post, put } from "../api";
import { copyText } from "../clipboard";
import { Badge, Button, Field, Group, Row, Section } from "../kit";
import type { AgentDescriptor, Provider, Snapshot } from "../types";
import { useDirtyFlag } from "./dirty";

type ContextForm = {
  modelContextWindow: string;
  modelAutoCompactTokenLimit: string;
};

const contextFormOf = (runtime?: Snapshot["runtime"]): ContextForm => ({
  modelContextWindow:
    runtime?.modelConfig?.modelContextWindow?.toString() || "",
  modelAutoCompactTokenLimit:
    runtime?.modelConfig?.modelAutoCompactTokenLimit?.toString() || "",
});

/** 复制「从终端接入同一 Runtime」的命令；可指定供应商。 */
export async function copyTerminalCommand(
  onToast: (message: string) => void,
  options: { providerId?: string; cwd?: string } = {},
) {
  const query = new URLSearchParams();
  if (options.providerId) query.set("providerId", options.providerId);
  if (options.cwd) query.set("cwd", options.cwd);
  const suffix = query.toString() ? `?${query}` : "";
  try {
    const result = await api<{ command: string }>(
      `/runtime/terminal-command${suffix}`,
    );
    onToast((await copyText(result.command)) ? "已复制终端命令" : "复制失败");
  } catch (err: any) {
    onToast(err?.message || "复制失败");
  }
}

/** Codex 详情：供应商入口、上下文、历史索引、终端接入。 */
export function CodexPage({
  agent,
  runtime,
  providers,
  defaultCwd,
  onOpenProviders,
  onSaved,
  onToast,
  onConfirmRuntimeRestart,
}: {
  agent?: AgentDescriptor;
  runtime?: Snapshot["runtime"];
  providers: Provider[];
  defaultCwd?: string;
  onOpenProviders: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirmRuntimeRestart: (run: () => Promise<void>) => void;
}) {
  const [contextForm, setContextForm] = useState(() =>
    contextFormOf(runtime),
  );
  const [baseline, setBaseline] = useState(contextForm);
  const [contextError, setContextError] = useState("");
  const [savingContext, setSavingContext] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const contextChanged =
    JSON.stringify(contextForm) !== JSON.stringify(baseline);
  useDirtyFlag("agents:codex-context", contextChanged);
  // 别处改了（或保存成功后快照回来）时，没在编辑就跟上服务端的值。
  useEffect(() => {
    const next = contextFormOf(runtime);
    if (JSON.stringify(next) === JSON.stringify(baseline)) return;
    setBaseline(next);
    if (!contextChanged) setContextForm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime?.modelConfig]);

  const codexProviders = providers.filter(
    (provider) =>
      !(
        provider.kind === "cc-switch" &&
        ((provider.model || "").toLowerCase().includes("claude") ||
          (provider.baseUrl || "").toLowerCase().includes("anthropic"))
      ),
  );
  const current = providers.find((provider) => provider.current);

  const requestContextSave = (event: React.FormEvent) => {
    event.preventDefault();
    setContextError("");
    const parseValue = (value: string, label: string) => {
      if (!value.trim()) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0)
        throw new Error(`${label}必须是正整数`);
      return parsed;
    };
    let modelContextWindow: number | null;
    let modelAutoCompactTokenLimit: number | null;
    try {
      modelContextWindow = parseValue(
        contextForm.modelContextWindow,
        "最大上下文",
      );
      modelAutoCompactTokenLimit = parseValue(
        contextForm.modelAutoCompactTokenLimit,
        "自动压缩阈值",
      );
      if (
        modelContextWindow != null &&
        modelAutoCompactTokenLimit != null &&
        modelAutoCompactTokenLimit >= modelContextWindow
      )
        throw new Error("自动压缩阈值必须小于最大上下文");
    } catch (err: any) {
      setContextError(err.message);
      return;
    }
    onConfirmRuntimeRestart(async () => {
      setContextError("");
      setSavingContext(true);
      try {
        onSaved(
          await put("/runtime/model-context", {
            modelContextWindow,
            modelAutoCompactTokenLimit,
          }),
        );
        setBaseline(contextForm);
        onToast("上下文设置已保存，Codex 服务已重启");
      } catch (err: any) {
        setContextError(err.message);
        throw err;
      } finally {
        setSavingContext(false);
      }
    });
  };

  const repairHistory = async () => {
    setRepairing(true);
    try {
      onSaved(await post("/agents/codex/history/repair"));
      onToast("Codex 历史索引修复完成");
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <>
      <Section title="连接">
        <Group>
          <Row
            onOpen={onOpenProviders}
            openLabel="管理供应商"
            title="供应商"
            badges={
              runtime?.configPending ? <Badge tone="warn">待应用</Badge> : null
            }
            desc={
              current
                ? `${codexProviders.length} 个可用，当前 ${current.name}`
                : `${codexProviders.length} 个可用`
            }
          />
          <Row
            dot={
              runtime?.online ? "ok" : runtime?.starting ? "busy" : "error"
            }
            title="服务"
            desc={
              runtime?.online
                ? runtime.remoteUrl
                : runtime?.starting
                  ? "启动中"
                  : runtime?.error?.split(/\r?\n/)[0] || "未运行"
            }
            descTone={
              !runtime?.online && !runtime?.starting ? "danger" : undefined
            }
            descTitle={runtime?.error}
            side={
              runtime?.online ? (
                <Button
                  size="sm"
                  title="复制从终端接入同一服务的命令"
                  onClick={() =>
                    void copyTerminalCommand(onToast, { cwd: defaultCwd })
                  }
                >
                  <SquareTerminal />
                  终端接入
                </Button>
              ) : undefined
            }
          />
        </Group>
      </Section>
      <Section
        title="上下文"
        desc="留空使用默认值。"
        actions={
          runtime?.modelConfigPending ? (
            <Badge
              tone="warn"
              title="已保存的值与正在运行的服务不一致，重启后生效"
            >
              待重启生效
            </Badge>
          ) : undefined
        }
      >
        <form onSubmit={requestContextSave}>
          <Group pad>
            <div className="ui-form__grid">
              <Field label="最大上下文">
                <input
                  className="ui-input"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={contextForm.modelContextWindow}
                  onChange={(event) =>
                    setContextForm((current) => ({
                      ...current,
                      modelContextWindow: event.target.value,
                    }))
                  }
                  placeholder="例如 1000000"
                />
              </Field>
              <Field label="自动压缩阈值">
                <input
                  className="ui-input"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={contextForm.modelAutoCompactTokenLimit}
                  onChange={(event) =>
                    setContextForm((current) => ({
                      ...current,
                      modelAutoCompactTokenLimit: event.target.value,
                    }))
                  }
                  placeholder="例如 900000"
                />
              </Field>
            </div>
            {contextError && <p className="ui-error">{contextError}</p>}
            <div className="ui-actions ui-actions--split">
              <span className="ui-field__hint">
                有任务运行时无法保存。
              </span>
              <Button
                type="submit"
                variant="primary"
                busy={savingContext}
                disabled={!contextChanged}
              >
                {savingContext ? "重启中…" : "保存并重启"}
              </Button>
            </div>
          </Group>
        </form>
      </Section>
      <Section title="历史索引">
        <Group>
          <Row
            dot={
              agent?.historyStatus === "error"
                ? "error"
                : agent?.historyStatus === "ready"
                  ? "ok"
                  : "busy"
            }
            title="索引"
            desc={
              agent?.historyStatus === "error"
                ? agent.historyError || "索引读取失败"
                : agent?.historyStatus === "ready"
                  ? "已同步"
                  : "正在同步"
            }
            descTone={agent?.historyStatus === "error" ? "danger" : undefined}
            side={
              <Button
                size="sm"
                busy={repairing}
                disabled={agent?.historyStatus === "loading"}
                title="重新扫描并修复索引"
                onClick={repairHistory}
              >
                {repairing ? "修复中…" : "修复"}
              </Button>
            }
          />
        </Group>
      </Section>
    </>
  );
}
