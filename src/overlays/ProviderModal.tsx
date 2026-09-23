import { useState } from "react";
import {
  Command,
  Database,
  Gauge,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { api, post, put, remove } from "../api";
import { copyText } from "../clipboard";
import type { AgentDescriptor, Provider, Snapshot } from "../types";
import { Modal } from "../ui";

type ReloadResult = Snapshot & {
  restarted: boolean;
  busyCount: number;
  ccSwitch: string | null;
};

export function ProviderModal({
  providers,
  agents,
  runtime,
  defaultCwd,
  onClose,
  onSaved,
  onToast,
  onConfirmDelete,
  onConfirmRuntimeRestart,
}: {
  providers: Provider[];
  agents: AgentDescriptor[];
  runtime?: Snapshot["runtime"];
  defaultCwd?: string;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirmDelete: (provider: Provider, run: () => Promise<void>) => void;
  onConfirmRuntimeRestart: (run: () => Promise<void>) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    wireApi: "responses",
  });
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [repairingHistory, setRepairingHistory] = useState(false);
  const [savingContext, setSavingContext] = useState(false);
  const [contextForm, setContextForm] = useState(() => ({
    modelContextWindow:
      runtime?.modelConfig?.modelContextWindow?.toString() || "",
    modelAutoCompactTokenLimit:
      runtime?.modelConfig?.modelAutoCompactTokenLimit?.toString() || "",
  }));
  const contextChanged =
    contextForm.modelContextWindow !==
      (runtime?.modelConfig?.modelContextWindow?.toString() || "") ||
    contextForm.modelAutoCompactTokenLimit !==
      (runtime?.modelConfig?.modelAutoCompactTokenLimit?.toString() || "");
  const hasCcSwitch = providers.some((p) => p.kind === "cc-switch");
  const codex = agents.find((agent) => agent.id === "codex");
  const isClaudeProvider = (p: Provider) => {
    const model = (p.model || "").toLowerCase();
    const url = (p.baseUrl || "").toLowerCase();
    return model.includes("claude") || url.includes("anthropic");
  };
  const repairHistory = async () => {
    setError("");
    setRepairingHistory(true);
    try {
      onSaved(await post("/agents/codex/history/repair"));
      onToast("Codex 历史索引修复完成");
    } catch (err: any) {
      setError(err.message);
      onToast(err.message);
    } finally {
      setRepairingHistory(false);
    }
  };
  const reloadRuntime = async () => {
    setError("");
    setReloading(true);
    try {
      const result = await post<ReloadResult>("/runtime/reload");
      onSaved(result);
      if (result.restarted) {
        onToast(
          result.ccSwitch
            ? "已重新读取 CC Switch 并重启 Runtime"
            : "未找到 CC Switch 数据库，已重启 Runtime",
        );
      } else {
        onToast(
          result.ccSwitch
            ? `已重新读取 CC Switch；${result.busyCount} 个会话仍在运行或等待审批，空闲后点「应用」重启`
            : `未找到 CC Switch 数据库；${result.busyCount} 个会话仍在运行，未重启 Runtime`,
        );
      }
    } catch (err: any) {
      setError(err.message);
      onToast(err.message);
    } finally {
      setReloading(false);
    }
  };
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
        onToast("上下文设置已保存，Codex Runtime 已重启");
      } catch (err: any) {
        setContextError(err.message);
        throw err;
      } finally {
        setSavingContext(false);
      }
    });
  };
  const copyCommand = async (providerId?: string) => {
    const query = new URLSearchParams();
    if (providerId) query.set("providerId", providerId);
    if (defaultCwd) query.set("cwd", defaultCwd);
    const suffix = query.toString() ? `?${query}` : "";
    const result = await api<{ command: string }>(
      `/runtime/terminal-command${suffix}`,
    );
    if (await copyText(result.command)) onToast("已复制");
    else onToast("复制失败");
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      onSaved(await post("/providers", { ...form, kind: "custom" }));
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <Modal title="供应商与隔离" onClose={onClose}>
      <div
        className={`sync-note${hasCcSwitch ? "" : " offline"}${reloading ? " reloading" : ""}`}
      >
        <RefreshCw />
        <div>
          <b>
            {hasCcSwitch ? "已连接 CC Switch · 只读同步" : "未连接 CC Switch"}
          </b>
          <small>
            {hasCcSwitch
              ? "供应商是 Session 的启动配置；已运行会话不会随 CCS 当前项变化。"
              : "安装或改完配置后，可重新读取并重启 Runtime。"}
          </small>
        </div>
        <button
          type="button"
          disabled={reloading}
          title="重新读取 CC Switch 并重启共享 Runtime"
          onClick={reloadRuntime}
        >
          {reloading ? "加载中…" : "重新加载"}
        </button>
      </div>
      <div className="sync-note runtime-context-note">
        <Gauge />
        <form
          className="form runtime-context-form"
          onSubmit={requestContextSave}
        >
          <div>
            <b>Codex 上下文</b>
            <small>
              留空使用模型与 Runtime 默认值；实际可用上限取决于模型和账号。
            </small>
          </div>
          <div className="form-grid">
            <label>
              最大上下文
              <input
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
              <code>model_context_window</code>
            </label>
            <label>
              自动压缩阈值
              <input
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
              <code>model_auto_compact_token_limit</code>
            </label>
          </div>
          <small className="runtime-context-warning">
            保存会重启共享 Codex Runtime；运行中或待审批时不能保存。不会改写
            ~/.codex/config.toml。
          </small>
          {contextError && <p className="error-text">{contextError}</p>}
          <button type="submit" disabled={savingContext || !contextChanged}>
            {savingContext
              ? "重启中…"
              : contextChanged
                ? "保存并重启"
                : "已应用"}
          </button>
        </form>
      </div>
      <div className="sync-note">
        <Database />
        <div>
          <b>Codex 历史索引</b>
          <small>
            {codex?.historyStatus === "error"
              ? codex.historyError || "索引读取失败"
              : codex?.historyStatus === "ready"
                ? "State DB 已同步"
                : "正在同步 State DB"}
          </small>
        </div>
        <button
          type="button"
          disabled={repairingHistory || codex?.historyStatus === "loading"}
          title="扫描原生 rollout 并修复 Codex State DB"
          onClick={repairHistory}
        >
          {repairingHistory ? "修复中…" : "修复"}
        </button>
      </div>
      <div className="provider-list">
        {(() => {
          const ccProviders = providers.filter((p) => p.kind === "cc-switch");
          const otherProviders = providers.filter(
            (p) => p.kind !== "cc-switch",
          );
          const codexCc = ccProviders.filter((p) => !isClaudeProvider(p));
          const claudeCc = ccProviders.filter((p) => isClaudeProvider(p));
          const renderRow = (p: Provider) => (
            <div className="provider-row" key={p.id}>
              <span
                className="provider-logo"
                style={{ "--color": p.color } as any}
              >
                <Server />
              </span>
              <div>
                <b>
                  {p.name}
                  {p.current && <mark>当前</mark>}
                </b>
                <small>
                  {p.kind === "cc-switch"
                    ? `${p.baseUrl || "官方登录"}${
                        p.baseUrl && !p.hasApiKey ? " · 无独立 Key" : ""
                      }`
                    : p.kind === "custom"
                      ? `${p.baseUrl} · ${p.wireApi || "responses"}`
                      : "使用当前 Codex 登录"}
                </small>
              </div>
              <span className={runtime?.online ? "online" : "offline-dot"}>
                {runtime?.configPending
                  ? "待应用"
                  : runtime?.online
                    ? "已装入"
                    : runtime?.starting
                      ? "启动中"
                      : "未装入"}
              </span>
              {runtime?.online && (
                <button
                  className="icon-btn"
                  type="button"
                  title={`复制 ${p.name} 的终端接入命令`}
                  onClick={() => copyCommand(p.id)}
                >
                  <Command />
                </button>
              )}
              {p.kind === "custom" && (
                <button
                  className="icon-btn danger"
                  title="删除"
                  onClick={() =>
                    onConfirmDelete(p, async () => {
                      onSaved(await remove(`/providers/${p.id}`));
                    })
                  }
                >
                  <Trash2 />
                </button>
              )}
            </div>
          );
          return (
            <>
              {otherProviders.map(renderRow)}
              {codexCc.length > 0 && (
                <>
                  <p className="provider-group-label">Codex 供应商</p>
                  {codexCc.map(renderRow)}
                </>
              )}
              {claudeCc.length > 0 && (
                <>
                  <p className="provider-group-label">Claude 供应商</p>
                  {claudeCc.map(renderRow)}
                </>
              )}
            </>
          );
        })()}
      </div>
      {runtime?.configPending && (
        <div className="sync-note pending">
          <RefreshCw />
          <div>
            <b>供应商配置有更新</b>
            <small>所有任务空闲后应用；运行中的 Session 不会被自动中断。</small>
          </div>
          <button
            className="primary"
            onClick={async () =>
              onSaved(await post("/runtime/apply-provider-config"))
            }
          >
            应用
          </button>
        </div>
      )}
      {runtime?.online && (
        <div className="terminal-connect">
          <Command />
          <div>
            <b>从终端接入同一 Runtime</b>
            <small>{runtime.remoteUrl} 仅监听本机，不经过 LAN / CF。</small>
          </div>
          <button type="button" onClick={() => copyCommand()}>
            复制命令
          </button>
        </div>
      )}
      <form className="form" onSubmit={save}>
        <h3>添加自定义供应商</h3>
        <label>
          显示名称
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：公司网关"
          />
        </label>
        <label>
          Base URL
          <input
            required
            type="url"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <div className="form-grid">
          <label>
            模型
            <input
              required
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="模型 ID"
            />
          </label>
          <label>
            接口
            <select
              value={form.wireApi}
              onChange={(e) => setForm({ ...form, wireApi: e.target.value })}
            >
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
        </div>
        <label>
          API Key
          <input
            required
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="只保存在本机服务端"
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit">
          <Plus />
          添加并连接
        </button>
      </form>
    </Modal>
  );
}
