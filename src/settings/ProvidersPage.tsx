import { useState } from "react";
import { Plus, RefreshCw, SquareTerminal, Trash2, X } from "lucide-react";
import { post, remove } from "../api";
import { Badge, Button, Field, Group, Note, Row, Section } from "../kit";
import type { AgentProfile, Provider, Snapshot } from "../types";
import { copyTerminalCommand } from "./CodexPage";
import { useDirtyFlag } from "./dirty";

type ReloadResult = Snapshot & {
  restarted: boolean;
  busyCount: number;
  ccSwitch: string | null;
};

const EMPTY_FORM = {
  agentId: "codex",
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
 * 供应商：不常用，放在设置导航的角落。CC Switch 同步（只读）+ 自定义
 * 供应商的增删。Runtime 状态只在顶部提示一次，不在每一行重复。
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
}: {
  providers: Provider[];
  claudeProfiles?: AgentProfile[];
  ccSwitch?: string | null;
  runtime?: Snapshot["runtime"];
  defaultCwd?: string;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirmDelete: (provider: Provider, run: () => Promise<void>) => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const formDirty =
    adding && JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  useDirtyFlag("providers:add", formDirty);
  const hasCcSwitch =
    Boolean(ccSwitch) ||
    providers.some((p) => p.kind === "cc-switch") ||
    claudeProfiles.some((p) => p.kind === "cc-switch");
  const ccProviders = providers.filter((p) => p.kind === "cc-switch");
  const otherProviders = providers.filter((p) => p.kind !== "cc-switch");
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
  const isClaudeForm = form.agentId === "claude";

  const reloadRuntime = async () => {
    setReloading(true);
    try {
      const result = await post<ReloadResult>("/runtime/reload");
      onSaved(result);
      if (result.restarted)
        onToast(
          result.ccSwitch
            ? "已重新读取 CC Switch 并重启 Runtime"
            : "已刷新本地供应商并重启 Runtime（未使用 CC Switch）",
        );
      else
        onToast(
          result.ccSwitch
            ? `已重新读取 CC Switch；${result.busyCount} 个会话仍在运行或等待审批，空闲后经「应用」重启`
            : `已刷新本地供应商；${result.busyCount} 个会话仍在运行，未重启 Runtime`,
        );
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setReloading(false);
    }
  };

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
      p.kind === "cc-switch"
        ? p.baseUrl || "官方登录"
        : p.kind === "custom"
          ? `${p.baseUrl} · ${p.agentId === "claude" ? "Anthropic Messages" : p.wireApi === "chat" ? "Chat Completions" : "Responses"}`
          : p.agentId === "claude"
            ? "使用本机 Claude 登录、settings.json 或环境变量"
            : "使用当前 Codex 登录",
      p.baseUrl && !p.hasApiKey ? "无独立 Key" : null,
    ]
      .filter(Boolean)
      .join(" · ");
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
              title={`复制用 ${p.name} 从终端接入的命令`}
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

  return (
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
            ? "Codex Runtime 启动中，供应商稍后装入。"
            : "Codex Runtime 未运行，供应商尚未装入。"}
        </Note>
      ) : null}
      <Note>
        无需安装 CC Switch。可使用本机 CLI 登录，或在这里添加 Codex、Claude
        自定义供应商。
      </Note>
      {providerSection("Codex · 本机与自定义", otherProviders)}
      {providerSection(
        "Claude · 本机与自定义",
        claudeProviders.filter((p) => p.kind !== "cc-switch"),
      )}
      {providerSection("Codex · CC Switch", ccProviders)}
      {providerSection(
        "Claude · CC Switch",
        claudeProviders.filter((p) => p.kind === "cc-switch"),
      )}
      <Section title="CC Switch · 可选兼容">
        <Group>
          <Row
            dot={hasCcSwitch ? "ok" : "off"}
            title={hasCcSwitch ? "已连接 · 只读同步" : "未检测到 · 不影响使用"}
            desc={
              hasCcSwitch
                ? "供应商是会话的启动配置；运行中的会话不随 CC Switch 的当前项变化。"
                : "使用本机或自定义供应商即可；以后安装 CC Switch 时，重新读取即可同步。"
            }
            side={
              <Button
                size="sm"
                busy={reloading}
                title="刷新本地配置与可选 CC Switch 来源；空闲时重启 Codex Runtime"
                onClick={reloadRuntime}
              >
                <RefreshCw className={reloading ? "ui-spin" : undefined} />
                {reloading ? "读取中…" : "重新读取"}
              </Button>
            }
          />
        </Group>
      </Section>
      <Section
        title="自定义供应商"
        desc="Codex 使用 OpenAI 兼容接口；Claude 使用 Anthropic 兼容接口。凭据只保存在本机服务端。"
        actions={
          adding ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setForm(EMPTY_FORM);
                setError("");
              }}
            >
              <X />
              取消
            </Button>
          ) : (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              添加
            </Button>
          )
        }
      >
        {adding && (
          <form onSubmit={save}>
            <Group pad>
              <Field label="Agent">
                <select
                  className="ui-input"
                  value={form.agentId}
                  onChange={(e) =>
                    setForm({ ...form, agentId: e.target.value })
                  }
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
              </Field>
              <Field label="显示名称">
                <input
                  className="ui-input"
                  required
                  autoFocus
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
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
                  placeholder={
                    isClaudeForm
                      ? "https://claude.example.com"
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
                  <select
                    className="ui-input"
                    value={isClaudeForm ? form.authType : form.wireApi}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [isClaudeForm ? "authType" : "wireApi"]: e.target.value,
                      })
                    }
                  >
                    {isClaudeForm ? (
                      <>
                        <option value="api-key">API Key</option>
                        <option value="auth-token">Auth Token</option>
                      </>
                    ) : (
                      <>
                        <option value="responses">Responses</option>
                        <option value="chat">Chat Completions</option>
                      </>
                    )}
                  </select>
                </Field>
              </div>
              <Field
                label={
                  isClaudeForm && form.authType === "auth-token"
                    ? "Auth Token"
                    : "API Key"
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
              <div className="ui-actions">
                <Button type="submit" variant="primary" busy={saving}>
                  {saving ? "添加中…" : "添加并连接"}
                </Button>
              </div>
            </Group>
          </form>
        )}
      </Section>
    </>
  );
}
