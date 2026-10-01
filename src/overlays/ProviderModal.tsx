import { useState } from "react";
import { Command, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, post, put, remove } from "../api";
import { copyText } from "../clipboard";
import { Badge, Button, Field, Group, Note, Row, Section, Seg } from "../kit";
import { AgentsPanel } from "../settings/AgentsPanel";
import { useAgentActions, type ConfirmFn } from "../settings/useAgentActions";
import type { AgentDescriptor, Provider, Snapshot } from "../types";
import { Modal } from "../ui";
import { OpenCodeAgentsSection } from "./OpenCodeAgentsSection";

export type SettingsTab = "global" | "agents" | "codex" | "claude" | "opencode";

const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: "global", label: "全局" },
  { value: "agents", label: "Agent" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "OpenCode" },
];

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
  initialTab = "global",
  onClose,
  onSaved,
  onToast,
  onConfirm,
  onConfirmDelete,
  onConfirmRuntimeRestart,
}: {
  providers: Provider[];
  agents: AgentDescriptor[];
  runtime?: Snapshot["runtime"];
  defaultCwd?: string;
  initialTab?: SettingsTab;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
  onConfirmDelete: (provider: Provider, run: () => Promise<void>) => void;
  onConfirmRuntimeRestart: (run: () => Promise<void>) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
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
  const actions = useAgentActions({ onSaved, onToast, onConfirm });
  const contextChanged =
    contextForm.modelContextWindow !==
      (runtime?.modelConfig?.modelContextWindow?.toString() || "") ||
    contextForm.modelAutoCompactTokenLimit !==
      (runtime?.modelConfig?.modelAutoCompactTokenLimit?.toString() || "");
  const hasCcSwitch = providers.some((p) => p.kind === "cc-switch");
  const codex = agents.find((agent) => agent.id === "codex");
  const opencode = agents.find((agent) => agent.id === "opencode");
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
  const ccProviders = providers.filter((p) => p.kind === "cc-switch");
  const otherProviders = providers.filter((p) => p.kind !== "cc-switch");
  const codexCc = ccProviders.filter((p) => !isClaudeProvider(p));
  const claudeCc = ccProviders.filter((p) => isClaudeProvider(p));
  const providerRow = (p: Provider) => (
    <Row
      key={p.id}
      lead={(p.name.trim()[0] || "?").toUpperCase()}
      leadColor={p.color}
      title={p.name}
      badges={p.current ? <Badge tone="ok">当前</Badge> : null}
      desc={
        p.kind === "cc-switch"
          ? `${p.baseUrl || "官方登录"}${
              p.baseUrl && !p.hasApiKey ? " · 无独立 Key" : ""
            }`
          : p.kind === "custom"
            ? `${p.baseUrl} · ${p.wireApi || "responses"}`
            : "使用当前 Codex 登录"
      }
      side={
        <>
          {/* 只标注例外：一切正常时每一行都写「已装入」只是噪音。 */}
          {runtime?.configPending ? (
            <Badge tone="warn">待应用</Badge>
          ) : runtime?.online ? null : (
            <Badge>{runtime?.starting ? "启动中" : "未装入"}</Badge>
          )}
          {runtime?.online && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              title={`复制 ${p.name} 的终端接入命令`}
              aria-label={`复制 ${p.name} 的终端接入命令`}
              onClick={() => copyCommand(p.id)}
            >
              <Command />
            </Button>
          )}
          {p.kind === "custom" && (
            <Button
              size="sm"
              variant="danger"
              iconOnly
              title="删除"
              aria-label={`删除 ${p.name}`}
              onClick={() =>
                onConfirmDelete(p, async () => {
                  onSaved(await remove(`/providers/${p.id}`));
                })
              }
            >
              <Trash2 />
            </Button>
          )}
        </>
      }
    />
  );
  const providerSection = (title: string, list: Provider[], desc?: string) =>
    list.length ? (
      <Section title={title} desc={desc}>
        <Group>{list.map(providerRow)}</Group>
      </Section>
    ) : null;
  return (
    <Modal title="设置" className="ui-panel settings-modal" onClose={onClose}>
      <div className="ui-panel__tabs">
        <Seg
          items={SETTINGS_TABS}
          value={tab}
          onChange={setTab}
          label="设置分类"
          idPrefix="settings"
        />
      </div>
      <div
        key={tab}
        className="ui-panel__body"
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "global" && (
          <>
            <Section title="供应商来源">
              <Group>
                <Row
                  dot={hasCcSwitch ? "ok" : "off"}
                  title={
                    hasCcSwitch
                      ? "已连接 CC Switch · 只读同步"
                      : "未连接 CC Switch"
                  }
                  desc={
                    hasCcSwitch
                      ? "供应商是 Session 的启动配置；已运行会话不会随 CCS 当前项变化。"
                      : "安装或改完配置后，可重新读取并重启 Runtime。"
                  }
                  side={
                    <Button
                      size="sm"
                      busy={reloading}
                      title="重新读取 CC Switch 并重启共享 Runtime"
                      onClick={reloadRuntime}
                    >
                      <RefreshCw
                        className={reloading ? "ui-spin" : undefined}
                      />
                      {reloading ? "加载中…" : "重新读取"}
                    </Button>
                  }
                />
              </Group>
            </Section>
            {runtime?.configPending && (
              <Note
                tone="warn"
                icon={<RefreshCw />}
                title="供应商配置有更新"
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () =>
                      onSaved(await post("/runtime/apply-provider-config"))
                    }
                  >
                    应用
                  </Button>
                }
              >
                所有任务空闲后应用；运行中的 Session 不会被自动中断。
              </Note>
            )}
            {providerSection("本地与自定义供应商", otherProviders)}
            {providerSection("Codex 供应商 · CC Switch", codexCc)}
            {providerSection("Claude 供应商 · CC Switch", claudeCc)}
            {runtime?.online && (
              <Section title="终端接入">
                <Group>
                  <Row
                    title="从终端接入同一 Runtime"
                    desc={`${runtime.remoteUrl} 仅监听本机，不经过 LAN / CF。`}
                    side={
                      <Button size="sm" onClick={() => copyCommand()}>
                        <Command />
                        复制命令
                      </Button>
                    }
                  />
                </Group>
              </Section>
            )}
          </>
        )}
        {tab === "agents" && <AgentsPanel agents={agents} actions={actions} />}
        {tab === "codex" && (
          <>
            <Section
              title="上下文"
              desc="留空使用模型与 Runtime 默认值；实际可用上限取决于模型和账号。"
            >
              <form onSubmit={requestContextSave}>
                <Group pad>
                  <div className="ui-form__grid">
                    <Field
                      label="最大上下文"
                      hint={<code>model_context_window</code>}
                    >
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
                    <Field
                      label="自动压缩阈值"
                      hint={<code>model_auto_compact_token_limit</code>}
                    >
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
                  <p className="ui-field__hint">
                    保存会重启共享 Codex
                    Runtime；运行中或待审批时不能保存。不会改写
                    ~/.codex/config.toml。
                  </p>
                  {contextError && <p className="ui-error">{contextError}</p>}
                  <div className="ui-actions">
                    <Button
                      type="submit"
                      busy={savingContext}
                      disabled={!contextChanged}
                    >
                      {savingContext
                        ? "重启中…"
                        : contextChanged
                          ? "保存并重启"
                          : "已应用"}
                    </Button>
                  </div>
                </Group>
              </form>
            </Section>
            <Section title="历史索引">
              <Group>
                <Row
                  dot={
                    codex?.historyStatus === "error"
                      ? "error"
                      : codex?.historyStatus === "ready"
                        ? "ok"
                        : "busy"
                  }
                  title="Codex 历史索引"
                  desc={
                    codex?.historyStatus === "error"
                      ? codex.historyError || "索引读取失败"
                      : codex?.historyStatus === "ready"
                        ? "State DB 已同步"
                        : "正在同步 State DB"
                  }
                  descTone={
                    codex?.historyStatus === "error" ? "danger" : undefined
                  }
                  side={
                    <Button
                      size="sm"
                      busy={repairingHistory}
                      disabled={codex?.historyStatus === "loading"}
                      title="扫描原生 rollout 并修复 Codex State DB"
                      onClick={repairHistory}
                    >
                      {repairingHistory ? "修复中…" : "修复"}
                    </Button>
                  }
                />
              </Group>
            </Section>
            <Section title="添加自定义供应商">
              <form onSubmit={save}>
                <Group pad>
                  <Field label="显示名称">
                    <input
                      className="ui-input"
                      required
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      placeholder="例如：公司网关"
                    />
                  </Field>
                  <Field label="Base URL">
                    <input
                      className="ui-input"
                      required
                      type="url"
                      value={form.baseUrl}
                      onChange={(e) =>
                        setForm({ ...form, baseUrl: e.target.value })
                      }
                      placeholder="https://api.example.com/v1"
                    />
                  </Field>
                  <div className="ui-form__grid">
                    <Field label="模型">
                      <input
                        className="ui-input"
                        required
                        value={form.model}
                        onChange={(e) =>
                          setForm({ ...form, model: e.target.value })
                        }
                        placeholder="模型 ID"
                      />
                    </Field>
                    <Field label="接口">
                      <select
                        className="ui-input"
                        value={form.wireApi}
                        onChange={(e) =>
                          setForm({ ...form, wireApi: e.target.value })
                        }
                      >
                        <option value="responses">Responses</option>
                        <option value="chat">Chat Completions</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="API Key">
                    <input
                      className="ui-input"
                      required
                      type="password"
                      value={form.apiKey}
                      onChange={(e) =>
                        setForm({ ...form, apiKey: e.target.value })
                      }
                      placeholder="只保存在本机服务端"
                    />
                  </Field>
                  {error && <p className="ui-error">{error}</p>}
                  <div className="ui-actions">
                    <Button type="submit" variant="primary">
                      <Plus />
                      添加并连接
                    </Button>
                  </div>
                </Group>
              </form>
            </Section>
          </>
        )}
        {tab === "claude" && (
          <>
            <Note tone="info" icon={<Info />}>
              Claude Code 的供应商由 CC Switch 管理；Claude 会话本身暂无单独的
              Deck 级设置。
            </Note>
            {claudeCc.length > 0 ? (
              providerSection("Claude 供应商 · CC Switch", claudeCc)
            ) : (
              <Section title="Claude 供应商" desc="没有 Claude 供应商。">
                {null}
              </Section>
            )}
          </>
        )}
        {tab === "opencode" && (
          <OpenCodeAgentsSection
            enabled={opencode?.enabled !== false}
            reloading={actions.pending.opencode === "reload"}
            onReload={() =>
              void actions.reload({
                id: "opencode",
                name: opencode?.name || "OpenCode",
              })
            }
          />
        )}
      </div>
    </Modal>
  );
}
