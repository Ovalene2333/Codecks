import { Select } from "../kit/Select";
import { useState } from "react";
import { Plus, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { post, put, remove } from "../api";
import { Badge, Button, Field, Group, Note, Row, Section, Seg } from "../kit";
import { Modal } from "../ui";
import type {
  AgentProfile,
  Provider,
  Snapshot,
} from "../types";
import { copyTerminalCommand } from "./CodexPage";
import { useDirtyFlag } from "./dirty";
import { OpenCodeProvidersSection } from "./OpenCodeProvidersSection";

type ReloadResult = Snapshot & {
  restarted: boolean;
  busyCount: number;
  ccSwitch: string | null;
};

type AgentTab = "codex" | "claude" | "opencode";

const EMPTY_FORM = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  wireApi: "responses",
  authType: "api-key",
};

export const isClaudeProvider = (p: Provider) => {
  const model = (p.model || "").toLowerCase();
  const url = (p.baseUrl || "").toLowerCase();
  return model.includes("claude") || url.includes("anthropic");
};

/**
 * 重新读取本地与 CC Switch 供应商（顺带重启服务让配置生效）：
 * 供应商页头右上角与 CC Switch 行内共用，各自独立的进行中状态。
 */
export function ReloadProvidersButton({
  onSaved,
  onToast,
}: {
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
}) {
  const [reloading, setReloading] = useState(false);
  const reloadRuntime = async () => {
    setReloading(true);
    try {
      const result = await post<ReloadResult>("/runtime/reload");
      onSaved(result);
      if (result.restarted)
        onToast(
          result.ccSwitch
            ? "已重新读取 CC Switch 并重启服务"
            : "已刷新本地供应商并重启服务（未使用 CC Switch）",
        );
      else
        onToast(
          result.ccSwitch
            ? `已重新读取 CC Switch；${result.busyCount} 个会话仍在运行或待确认，空闲后经「应用」重启`
            : `已刷新本地供应商；${result.busyCount} 个会话仍在运行，未重启服务`,
        );
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setReloading(false);
    }
  };
  return (
    <Button
      size="sm"
      busy={reloading}
      title="重新读取本地与 CC Switch 供应商"
      onClick={() => void reloadRuntime()}
    >
      <RefreshCw className={reloading ? "ui-spin" : undefined} />
      {reloading ? "读取中…" : "重新读取"}
    </Button>
  );
}

/**
 * 供应商：按 Agent 分签（Codex / Claude / OpenCode）。
 * Codex 与 Claude 是 Deck 代管的自定义供应商增删；OpenCode 是
 * opencode.json 自定义供应商的文件编辑。Runtime 状态只在
 * Codex 签顶部提示一次，不在每一行重复。
 */
export function ProvidersPage({
  providers,
  claudeProfiles = [],
  ccSwitch,
  runtime,
  defaultCwd,
  onSaved,
  onToast,
  onConfirmDelete,
  onNeedsReload,
}: {
  providers: Provider[];
  claudeProfiles?: AgentProfile[];
  ccSwitch?: string | null;
  runtime?: Snapshot["runtime"];
  defaultCwd?: string;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirmDelete: (provider: Provider, run: () => Promise<void>) => void;
  /** OpenCode 供应商写入成功后点亮「OpenCode 有配置等待生效」提示条。 */
  onNeedsReload?: () => void;
}) {
  const [tab, setTab] = useState<AgentTab>("codex");
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const formDirty =
    adding && JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  useDirtyFlag("providers:add", formDirty);
  const hasCcSwitch =
    Boolean(ccSwitch) ||
    providers.some((p) => p.kind === "cc-switch") ||
    claudeProfiles.some((p) => p.kind === "cc-switch");
  const ccProviders = providers.filter((p) => p.kind === "cc-switch");
  const codexCustom = providers.filter((p) => p.kind === "custom");
  const claudeProviders: Provider[] = claudeProfiles.map((profile) => ({
    ...profile,
    kind:
      profile.kind ||
      (profile.id === "claude-local" ? "local-profile" : "cc-switch"),
    color: profile.color || "#d97757",
    enabled: profile.enabled !== false,
    online: Boolean(profile.online),
    hasApiKey: Boolean(profile.hasApiKey),
  }));
  const claudeCustom = claudeProviders.filter((p) => p.kind === "custom");
  const claudeCc = claudeProviders.filter((p) => p.kind === "cc-switch");
  const isClaudeForm = tab === "claude";

  const applyPending = async () => {
    setApplying(true);
    try {
      onSaved(await post("/runtime/apply-provider-config"));
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setApplying(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      onSaved(
        await post(isClaudeForm ? "/claude/providers" : "/providers", {
          ...form,
          agentId: isClaudeForm ? "claude" : "codex",
          kind: "custom",
        }),
      );
      onToast(`已添加 ${form.name.trim()}`);
      setForm(EMPTY_FORM);
      setAdding(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const providerDesc = (p: Provider) =>
    [
      p.model,
      p.kind === "cc-switch" ? p.baseUrl || "官方登录" : p.baseUrl,
      p.baseUrl && !p.hasApiKey ? "无独立密钥" : null,
    ]
      .filter(Boolean)
      .join("，");
  const providerRow = (p: Provider) => (
    <Row
      key={p.id}
      lead={(p.name.trim()[0] || "?").toUpperCase()}
      leadColor={p.color}
      title={p.name}
      badges={
        <>
          {p.current ? <Badge tone="ok">当前</Badge> : null}
          {!p.enabled ? <Badge tone="warn">不可用</Badge> : null}
          {p.error ? <Badge tone="danger">异常</Badge> : null}
          {!p.online && !p.error ? <Badge tone="warn">离线</Badge> : null}
        </>
      }
      desc={providerDesc(p)}
      descTitle={p.error}
      side={
        <>
          {runtime?.online && p.agentId !== "claude" && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              title={`复制终端接入命令：${p.name}`}
              aria-label={`复制用 ${p.name} 从终端接入的命令`}
              onClick={() =>
                void copyTerminalCommand(onToast, {
                  providerId: p.id,
                  cwd: defaultCwd,
                })
              }
            >
              <SquareTerminal />
            </Button>
          )}
          {p.kind === "custom" && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              title={`删除 ${p.name}`}
              aria-label={`删除 ${p.name}`}
              onClick={() =>
                onConfirmDelete(p, async () => {
                  onSaved(
                    await remove(
                      `${p.agentId === "claude" ? "/claude" : ""}/providers/${p.id}`,
                    ),
                  );
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
  const providerSection = (title: string, list: Provider[]) =>
    list.length ? (
      <Section title={title}>
        <Group>{list.map(providerRow)}</Group>
      </Section>
    ) : null;

  const customRows = isClaudeForm ? claudeCustom : codexCustom;
  const closeForm = () => {
    setAdding(false);
    setForm(EMPTY_FORM);
    setError("");
  };
  const customForm = (
    <Section
      title={isClaudeForm ? "Claude 自定义供应商" : "Codex 自定义供应商"}
      desc="凭据只保存在本机。"
      actions={
        adding ? undefined : (
          <Button
            size="sm"
            onClick={() => {
              setForm(EMPTY_FORM);
              setError("");
              setAdding(true);
            }}
          >
            <Plus />
            添加
          </Button>
        )
      }
    >
      {customRows.length ? (
        <Group>{customRows.map(providerRow)}</Group>
      ) : null}
    </Section>
  );
  const formDialog = adding ? (
    <Modal title="新增供应商" className="ui-panel" onClose={closeForm}>
      <div className="ui-panel__body">
        <form onSubmit={save} className="ui-form-dialog">
          <div className="ui-form-dialog__body">
            <Field label="显示名称">
              <input
                className="ui-input"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：公司网关"
              />
            </Field>
            <Field label="服务地址">
              <input
                className="ui-input"
                required
                type="url"
                value={form.baseUrl}
                onChange={(e) =>
                  setForm({ ...form, baseUrl: e.target.value })
                }
                placeholder={
                  isClaudeForm
                    ? "https://api.example.com"
                    : "https://api.example.com/v1"
                }
              />
            </Field>
            <div className="ui-form__grid">
              <Field label={isClaudeForm ? "默认模型（可选）" : "模型"}>
                <input
                  className="ui-input"
                  required={!isClaudeForm}
                  value={form.model}
                  onChange={(e) =>
                    setForm({ ...form, model: e.target.value })
                  }
                  placeholder={
                    isClaudeForm ? "留空跟随 Claude 默认模型" : "模型 ID"
                  }
                />
              </Field>
              <Field label={isClaudeForm ? "认证方式" : "接口"}>
                <Select
                  className="ui-input"
                  value={isClaudeForm ? form.authType : form.wireApi}
                  onValueChange={(nextValue) =>
                    setForm({
                      ...form,
                      [isClaudeForm ? "authType" : "wireApi"]: nextValue,
                    })
                  }
                >
                  {isClaudeForm ? (
                    <>
                      <option value="api-key">API 密钥</option>
                      <option value="auth-token">认证令牌</option>
                    </>
                  ) : (
                    <>
                      <option value="responses">Responses</option>
                      <option value="chat">Chat Completions</option>
                    </>
                  )}
                </Select>
              </Field>
            </div>
            <Field
              label={
                isClaudeForm && form.authType === "auth-token"
                  ? "认证令牌"
                  : "API 密钥"
              }
            >
              <input
                className="ui-input"
                required
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </Field>
            {error && <p className="ui-error">{error}</p>}
          </div>
          <div className="ui-form-dialog__footer">
            <Button type="button" onClick={closeForm}>
              取消
            </Button>
            <Button type="submit" variant="primary" busy={saving}>
              {saving ? "添加中…" : "添加并连接"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  ) : null;

  return (
    <>
      <Seg<AgentTab>
        label="按 Agent 查看供应商"
        className="ui-seg--page"
        value={tab}
        onChange={(next) => {
          setTab(next);
          setAdding(false);
          setError("");
        }}
        items={[
          { value: "codex", label: "Codex" },
          { value: "claude", label: "Claude" },
          { value: "opencode", label: "OpenCode" },
        ]}
      />
      {tab === "codex" && (
        <>
          {runtime?.configPending ? (
            <Note
              tone="warn"
              icon={<RefreshCw />}
              title="供应商配置有更新"
              action={
                <Button
                  size="sm"
                  variant="primary"
                  busy={applying}
                  onClick={() => void applyPending()}
                >
                  应用
                </Button>
              }
            >
              所有任务空闲后应用；运行中的会话不会被自动中断。
            </Note>
          ) : runtime && !runtime.online ? (
            <Note tone="warn" icon={<RefreshCw />}>
              {runtime.starting
                ? "Codex 服务启动中，供应商稍后装入。"
                : "Codex 服务未运行，供应商尚未装入。"}
            </Note>
          ) : null}
          {providerSection("CC Switch", ccProviders)}
          <Section title="CC Switch">
            <Group>
              <Row
                dot={hasCcSwitch ? "ok" : "off"}
                title={hasCcSwitch ? "已连接，只读同步" : "未检测到，不影响使用"}
                desc={
                  hasCcSwitch
                    ? "切换当前项不影响运行中的会话。"
                    : "未安装不影响使用；安装后点「重新读取」同步。"
                }
                side={
                  <ReloadProvidersButton onSaved={onSaved} onToast={onToast} />
                }
              />
            </Group>
          </Section>
          {customForm}
          {formDialog}
        </>
      )}
      {tab === "claude" && (
        <>
          {providerSection("CC Switch", claudeCc)}
          {customForm}
          {formDialog}
        </>
      )}
      {tab === "opencode" && (
        <OpenCodeProvidersSection
          defaultCwd={defaultCwd}
          onToast={onToast}
          onNeedsReload={onNeedsReload}
        />
      )}
    </>
  );
}
