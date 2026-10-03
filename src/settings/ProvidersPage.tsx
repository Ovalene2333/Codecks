import { useState } from "react";
import { Plus, RefreshCw, SquareTerminal, Trash2, X } from "lucide-react";
import { post, remove } from "../api";
import { Badge, Button, Field, Group, Note, Row, Section } from "../kit";
import type { Provider, Snapshot } from "../types";
import { copyTerminalCommand } from "./CodexPage";
import { useDirtyFlag } from "./dirty";

type ReloadResult = Snapshot & {
  restarted: boolean;
  busyCount: number;
  ccSwitch: string | null;
};

const EMPTY_FORM = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  wireApi: "responses",
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
  runtime,
  defaultCwd,
  onSaved,
  onToast,
  onConfirmDelete,
}: {
  providers: Provider[];
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
  const formDirty = adding && JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  useDirtyFlag("providers:add", formDirty);
  const hasCcSwitch = providers.some((p) => p.kind === "cc-switch");
  const ccProviders = providers.filter((p) => p.kind === "cc-switch");
  const otherProviders = providers.filter((p) => p.kind !== "cc-switch");
  const codexCc = ccProviders.filter((p) => !isClaudeProvider(p));
  const claudeCc = ccProviders.filter((p) => isClaudeProvider(p));

  const reloadRuntime = async () => {
    setReloading(true);
    try {
      const result = await post<ReloadResult>("/runtime/reload");
      onSaved(result);
      if (result.restarted)
        onToast(
          result.ccSwitch
            ? "已重新读取 CC Switch 并重启 Runtime"
            : "未找到 CC Switch 数据库，已重启 Runtime",
        );
      else
        onToast(
          result.ccSwitch
            ? `已重新读取 CC Switch；${result.busyCount} 个会话仍在运行或等待审批，空闲后经「应用」重启`
            : `未找到 CC Switch 数据库；${result.busyCount} 个会话仍在运行，未重启 Runtime`,
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
      onSaved(await post("/providers", { ...form, kind: "custom" }));
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
          ? `${p.baseUrl} · ${p.wireApi === "chat" ? "Chat Completions" : "Responses"}`
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
          {p.error ? <Badge tone="danger">异常</Badge> : null}
          {!p.online && !p.error ? <Badge tone="warn">离线</Badge> : null}
        </>
      }
      desc={providerDesc(p)}
      descTitle={p.error}
      side={
        <>
          {runtime?.online && (
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
      <Section title="CC Switch">
        <Group>
          <Row
            dot={hasCcSwitch ? "ok" : "off"}
            title={hasCcSwitch ? "已连接 · 只读同步" : "未连接"}
            desc={
              hasCcSwitch
                ? "供应商是会话的启动配置；运行中的会话不随 CC Switch 的当前项变化。"
                : "安装或修改 CC Switch 配置后，重新读取即可同步。"
            }
            side={
              <Button
                size="sm"
                busy={reloading}
                title="重新读取 CC Switch 并重启共享 Runtime"
                onClick={reloadRuntime}
              >
                <RefreshCw className={reloading ? "ui-spin" : undefined} />
                {reloading ? "读取中…" : "重新读取"}
              </Button>
            }
          />
        </Group>
      </Section>
      {providerSection("本地与自定义", otherProviders)}
      {providerSection("Codex · CC Switch", codexCc)}
      {providerSection("Claude · CC Switch", claudeCc)}
      <Section
        title="自定义供应商"
        desc="OpenAI 兼容网关，仅用于 Codex。API Key 只保存在本机服务端。"
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
