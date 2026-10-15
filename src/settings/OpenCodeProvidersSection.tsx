import { Select } from "../kit/Select";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Image as ImageIcon, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, post, remove } from "../api";
import { Button, Disclosure, Dot, Field, Group, Note, SearchField, Switch, type DotTone } from "../kit";
import { Modal } from "../ui";
import { useDirtyFlag } from "./dirty";

interface ProviderModel {
  id: string;
  name?: string;
  variants?: string[];
  /** 是否支持图片输入（modalities.input 含 image）；缺省表示未知。 */
  supportsImages?: boolean;
  /** 按模型覆盖的 SDK 包；缺省=跟随供应商。 */
  sdk?: string;
}

interface FileProvider {
  id: string;
  name: string;
  npm?: string;
  baseURL?: string;
  /** 文件里声明了 apiKey（明文或模板）。 */
  hasApiKey: boolean;
  apiKeyHint?: string;
  /** OpenCode 运行时探测结果；离线或未探测时缺省。 */
  connected?: boolean;
  models: ProviderModel[];
}

interface ProviderFile {
  scope: "global" | "project";
  path: string;
  /** 家目录收成 `~` 的展示路径；缺省时回退全路径。 */
  displayPath?: string;
  exists: boolean;
  providers: FileProvider[];
}

interface ProvidersResponse {
  online: boolean;
  global: ProviderFile;
  project?: ProviderFile;
}

interface ModelDraft {
  key: number;
  id: string;
  name: string;
  variants: string[];
  variantInput: string;
  /** undefined=保持原 modalities，true/false=改写是否支持图片输入。 */
  supportsImages: boolean | undefined;
  /** ""=跟随供应商，非空=按模型覆盖 SDK 包。 */
  sdk: string;
}

const EMPTY_MODEL = (key: number): ModelDraft => ({
  key,
  id: "",
  name: "",
  variants: [],
  variantInput: "",
  supportsImages: undefined,
  sdk: "",
});

interface ProviderForm {
  scope: "global" | "project";
  id: string;
  name: string;
  npm: string;
  baseURL: string;
  apiKey: string;
  models: ModelDraft[];
}

const EMPTY_FORM: ProviderForm = {
  scope: "global",
  id: "",
  name: "",
  npm: "@ai-sdk/openai-compatible",
  baseURL: "",
  apiKey: "",
  models: [EMPTY_MODEL(1)],
};

let draftKey = 2;
const nextKey = () => draftKey++;

function draftsOf(models: ProviderModel[]): ModelDraft[] {
  if (!models.length) return [EMPTY_MODEL(nextKey())];
  return models.map((model) => ({
    key: nextKey(),
    id: model.id,
    name: model.name && model.name !== model.id ? model.name : "",
    variants: [...(model.variants || [])],
    variantInput: "",
    supportsImages: model.supportsImages,
    sdk: model.sdk || "",
  }));
}

const variantsOf = (model: ProviderModel) => (model.variants || []).filter(Boolean);

/** 可选的 SDK 包：与供应商同选单，另有按模型覆盖。标签写全称，两个 openai 不再长得一样。 */
const SDK_OPTIONS = [
  { value: "@ai-sdk/openai-compatible", label: "OpenAI 兼容（Chat Completions）" },
  { value: "@ai-sdk/openai", label: "OpenAI（Responses）" },
  { value: "@ai-sdk/anthropic", label: "Anthropic（Messages）" },
];

/** 接口简称：兼容 / Responses / Anthropic；未知包去 scope 原样显示。 */
const sdkShort = (npm?: string) =>
  npm === "@ai-sdk/openai"
    ? "Responses"
    : npm === "@ai-sdk/anthropic"
      ? "Anthropic"
      : npm === "@ai-sdk/openai-compatible"
        ? "兼容"
        : (npm || "").replace(/^@ai-sdk\//, "");

/** 下拉里兜底：文件里有选单之外的包时，原样保留一项可回选。 */
const sdkExtraOption = (value: string) =>
  value && !SDK_OPTIONS.some((option) => option.value === value) ? (
    <option key={value} value={value}>
      {value}
    </option>
  ) : null;

/**
 * Key 状态：文件里声明了 apiKey 即有；否则以 OpenCode 运行时为准（auth.json
 * 登录或环境变量同样算有）。OpenCode 未运行或探测失败时只能说“未探测”。
 */
function keyStatus(
  provider: FileProvider,
  probed: boolean,
): { tone: DotTone; text: string; title?: string } {
  if (provider.hasApiKey) return { tone: "ok", text: "有密钥" };
  if (provider.connected === true)
    return { tone: "ok", text: "有密钥", title: "OpenCode 已连接该供应商（凭据来自登录信息或环境变量）" };
  if (provider.connected === false) return { tone: "warn", text: "无密钥" };
  if (probed)
    return { tone: "off", text: "未探测", title: "OpenCode 未运行或探测失败，无法确认凭据" };
  return { tone: "off", text: "探测中", title: "正在向 OpenCode 确认该供应商的凭据" };
}

/**
 * OpenCode 自定义 provider（opencode.json）：解析全局/项目文件的
 * `provider`（V1）/`providers`（V2）段并管理。供应商页只做数据维护，
 * 生效反馈走 SettingsModal 顶部的 needsReload 提示条；重载/重启集中在
 * Agent→OpenCode 的服务状态 Section。
 */
export function OpenCodeProvidersSection({
  defaultCwd,
  onToast,
  onNeedsReload,
}: {
  defaultCwd?: string;
  onToast: (message: string) => void;
  /** 写入/删除成功后点亮 SettingsModal 的「OpenCode 有配置等待生效」提示条。 */
  onNeedsReload?: () => void;
}) {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [probed, setProbed] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** 列表过滤（对标商业设置页的顶部搜索框）：按供应商/模型名过滤。 */
  const [query, setQuery] = useState("");

  // 列表秒回（文件解析是毫秒级）；connected 徽标随后由新鲜探测补齐，
  // 不让 serve 的 `/provider`（单次 1 秒多）挡住整个列表渲染。
  const applyConnected = useCallback(
    (global: string[] | null, project: string[] | null) => {
      setData((current) => {
        if (!current) return current;
        const withConnected = (
          file: ProviderFile | undefined,
          connected: string[] | null,
        ) =>
          file && connected
            ? {
                ...file,
                providers: file.providers.map((provider) => ({
                  ...provider,
                  connected: connected.includes(provider.id),
                })),
              }
            : file;
        return {
          ...current,
          global: withConnected(current.global, global) ?? current.global,
          project: withConnected(current.project, project) ?? current.project,
        };
      });
    },
    [],
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const query = defaultCwd ? `?directory=${encodeURIComponent(defaultCwd)}` : "";
      const result = await api<ProvidersResponse>(`/agents/opencode/providers${query}`);
      setData(result);
      if (!result.online) {
        setProbed(true);
        return;
      }
      // 在线才值得等新鲜探测；失败只落成“未探测”，不报错。
      try {
        const status = await api<{ global: string[] | null; project: string[] | null }>(
          `/agents/opencode/connected${query}`,
        );
        applyConnected(status.global, status.project);
      } catch {
        // 忽略：徽标保持“探测中”转“未探测”。
      } finally {
        setProbed(true);
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, [defaultCwd, applyConnected]);

  useEffect(() => {
    setData(null);
    setProbed(false);
    void load();
  }, [load]);

  const formDirty = adding && JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  useDirtyFlag("providers:opencode", formDirty);

  const setModel = (key: number, patch: Partial<ModelDraft>) =>
    setForm((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.key === key ? { ...model, ...patch } : model,
      ),
    }));

  const startAdd = () => {
    setForm({ ...EMPTY_FORM, scope: defaultCwd ? form.scope : "global", models: [EMPTY_MODEL(nextKey())] });
    setEditing(null);
    setAdding(true);
  };
  const startEdit = (scope: "global" | "project", provider: FileProvider) => {
    setForm({
      scope,
      id: provider.id,
      name: provider.name === provider.id ? "" : provider.name,
      npm: provider.npm || "@ai-sdk/openai-compatible",
      baseURL: provider.baseURL || "",
      apiKey: "",
      models: draftsOf(provider.models),
    });
    setEditing(`${scope}:${provider.id}`);
    setAdding(true);
  };

  const addVariant = (key: number) => {
    const target = form.models.find((model) => model.key === key);
    if (!target) return;
    const name = target.variantInput.trim();
    if (!name) return;
    if (target.variants.includes(name)) {
      setModel(key, { variantInput: "" });
      return;
    }
    setModel(key, { variants: [...target.variants, name], variantInput: "" });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const models = form.models
        .map((model) => ({
          id: model.id.trim(),
          name: model.name.trim() || undefined,
          variants: model.variants.map((name) => name.trim()).filter(Boolean),
          supportsImages: model.supportsImages,
          sdk: model.sdk,
        }))
        .filter((model) => model.id);
      if (!models.length) throw new Error("至少填写一个模型 ID");
      const seen = new Set<string>();
      for (const model of models) {
        if (seen.has(model.id)) throw new Error(`模型 ${model.id} 重复声明`);
        seen.add(model.id);
      }
      const body: Record<string, unknown> = {
        scope: form.scope,
        ...(form.scope === "project" && defaultCwd ? { directory: defaultCwd } : {}),
        id: form.id.trim(),
        name: form.name.trim() || undefined,
        npm: form.npm.trim() || undefined,
        baseURL: form.baseURL.trim(),
        models,
      };
      // 编辑时留空 = 保持原 Key；新增时可留空（稍后 opencode auth login 补）。
      // 填了值才提交，避免把掩码状态误写成空。
      if (form.apiKey) body.apiKey = form.apiKey;
      else if (!editing) body.apiKey = undefined;
      await post("/agents/opencode/providers", body);
      onToast(`已写入${form.scope === "project" ? "项目" : "全局"}配置，重载 OpenCode 后生效`);
      onNeedsReload?.();
      setAdding(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err: any) {
      onToast(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeProvider = async (scope: "global" | "project", id: string) => {
    try {
      await remove(
        `/agents/opencode/providers/${encodeURIComponent(id)}?scope=${scope}${scope === "project" && defaultCwd ? `&directory=${encodeURIComponent(defaultCwd)}` : ""}`,
      );
      onToast(`已删除供应商 ${id}，重载 OpenCode 后生效`);
      onNeedsReload?.();
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      onToast(err?.message || String(err));
    }
  };

  /** 分组描述只露文件名，全路径收进 hover，长路径不再撑版面。 */
  const fileName = (value: string) => value.split(/[\\/]/).pop() || value;
  const needle = query.trim().toLowerCase();

  const renderList = (file: ProviderFile | undefined, title: string, actions?: ReactNode) => {
    if (!file) return null;
    const visible = needle
      ? file.providers.filter((provider) =>
          [provider.id, provider.name, provider.baseURL, ...provider.models.map((model) => model.id)]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : file.providers;
    // 标题一行带完：分组名 + 浅色计数 + 来源文件名，按钮靠右，窄屏也不折行。
    return (
      <section key={title} className="ui-pgroup">
        <header className="ui-pgroup__head">
          <div className="ui-pgroup__label">
            <h3 className="ui-pgroup__title">{title}</h3>
            <span className="ui-pgroup__count">{visible.length}</span>
            <span className="ui-pgroup__file" title={file.path}>
              {fileName(file.path)}
            </span>
          </div>
          {actions ? <div className="ui-pgroup__actions">{actions}</div> : null}
        </header>
        {!visible.length ? (
          <p className="ui-pgroup__empty">{needle ? `没有匹配「${query.trim()}」的供应商。` : "暂无自定义供应商。"}</p>
        ) : (
        <div className="ui-pcard-list">
          {visible.map((provider) => {
            const key = `${file.scope}:${provider.id}`;
            const status = keyStatus(provider, probed);
            return (
              <article key={key} className="ui-pcard">
                <header className="ui-pcard__head">
                  <Dot tone={status.tone} />
                  <div className="ui-pcard__title">
                    <span className="ui-pcard__name" title={provider.name}>
                      {provider.name}
                    </span>
                    {provider.name !== provider.id && (
                      <span className="ui-pcard__id" title={`供应商标识：${provider.id}`}>
                        {provider.id}
                      </span>
                    )}
                    <span
                      className={`ui-pcard__status${status.tone === "warn" ? " is-warn" : ""}`}
                      title={status.title}
                    >
                      {status.text}
                    </span>
                  </div>
                  <div className="ui-pcard__actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      title={`编辑 ${provider.id}`}
                      aria-label={`编辑 ${provider.id}`}
                      onClick={() => startEdit(file.scope, provider)}
                    >
                      <Pencil />
                    </Button>
                    {confirmDelete === key ? (
                      <Button
                        size="sm"
                        variant="primary"
                        title="确认删除"
                        onClick={() => void removeProvider(file.scope, provider.id)}
                      >
                        确认删除
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        title={`删除 ${provider.id}`}
                        aria-label={`删除 ${provider.id}`}
                        onClick={() => setConfirmDelete(key)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </header>
                {provider.models.length ? (
                  <div className="ui-pcard__models">
                    {provider.models.map((model) => {
                      const variantCount = variantsOf(model).length;
                      const hasVariants = variantCount > 0;
                      const displayName =
                        model.name && model.name !== model.id ? model.name : model.id;
                      const visionState =
                        model.supportsImages === true
                          ? "支持图片输入"
                          : model.supportsImages === false
                            ? "不支持图片输入"
                            : "";
                      const sdkLabel = sdkShort(model.sdk || provider.npm);
                      const stateText = [
                        hasVariants ? `${variantCount} 档` : "无档位",
                        visionState,
                        sdkLabel ? `接口${sdkLabel}` : "",
                      ]
                        .filter(Boolean)
                        .join("，");
                      // 只给覆盖了供应商 SDK 的模型打标记，跟随的不打扰。
                      const sdkOverride =
                        model.sdk && model.sdk !== provider.npm ? sdkShort(model.sdk) : "";
                      return (
                        <span
                          key={model.id}
                          className="ui-pcard__model"
                          title={
                            displayName === model.id
                              ? stateText
                              : `${model.id} · ${stateText}`
                          }
                        >
                          {displayName}
                          {hasVariants ? (
                            <span className="ui-pcard__model-meta">{variantCount} 档</span>
                          ) : null}
                          {sdkOverride ? (
                            <span className="ui-pcard__model-meta">{sdkOverride}</span>
                          ) : null}
                          {model.supportsImages ? (
                            <ImageIcon className="ui-pcard__model-icon" aria-hidden />
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <p className="ui-pcard__missing">未声明模型</p>
                )}
                {provider.baseURL ? (
                  <p className="ui-pcard__url" title={provider.baseURL}>
                    {provider.baseURL}
                  </p>
                ) : (
                  <p className="ui-pcard__url ui-pcard__url--missing">未填服务地址</p>
                )}
              </article>
            );
          })}
        </div>
        )}
      </section>
    );
  };

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setConfirmDelete(null);
  };

  // 工具栏：搜索 + 添加（对标商业设置页）。重载是全页动作，
  // 放在页顶提示条里并写明“修改后需重载”。
  const toolbar = data ? (
    <div className="ui-pgroup__toolbar">
      <SearchField
        value={query}
        onChange={setQuery}
        label="搜索供应商"
        placeholder="搜索供应商、模型、地址…"
      />
      {!adding ? (
        <Button size="sm" onClick={startAdd}>
          <Plus />
          添加供应商
        </Button>
      ) : null}
    </div>
  ) : null;

  const modelAdvancedOpen = (model: ModelDraft, index: number) =>
    index === 0 || Boolean(model.sdk || model.variants.length || model.supportsImages !== undefined);

  const formDialog = adding ? (
    <Modal
      title={editing ? `编辑 ${form.id}` : "新增供应商"}
      className="ui-panel"
      onClose={closeForm}
    >
      <div className="ui-panel__body">
        <form onSubmit={save} className="ui-form-dialog">
          <div className="ui-form-dialog__body">
            {defaultCwd && (
              <Field label="写入位置">
                <Select
                  className="ui-input"
                  value={form.scope}
                  disabled={Boolean(editing)}
                  onValueChange={(nextValue) => setForm({ ...form, scope: nextValue as "global" | "project" })}
                >
                  <option value="global">全局</option>
                  <option value="project">本项目（{defaultCwd}）</option>
                </Select>
              </Field>
            )}
            <div className="ui-form__grid">
              <Field label="供应商 ID">
                <input
                  className="ui-input"
                  required
                  disabled={Boolean(editing)}
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="例如：acme"
                />
              </Field>
              <Field label="显示名称（可选）">
                <input
                  className="ui-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="默认与 ID 相同"
                />
              </Field>
            </div>
            <div className="ui-form__grid ui-form__grid--top">
              <Field label="接口">
                <Select
                  className="ui-input"
                  value={form.npm}
                  onValueChange={(nextValue) => setForm({ ...form, npm: nextValue })}
                >
                  {SDK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {sdkExtraOption(form.npm)}
                </Select>
              </Field>
              <Field label="服务地址">
                <input
                  className="ui-input"
                  required
                  type="url"
                  value={form.baseURL}
                  onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
            </div>
            <Field label={editing ? "API 密钥（留空保持不变）" : "API 密钥（可选）"}>
              <input
                className="ui-input"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="{env:ACME_API_KEY} 或明文"
              />
            </Field>
            <Field
              group
              label="模型"
              hint="至少声明一个模型。"
            >
              <div className="ui-model-list">
                {form.models.map((model, index) => (
                  <div key={model.key} className="ui-model-card">
                    <div className="ui-model-card__head">
                      <span className="ui-model-card__title">模型 {index + 1}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        type="button"
                        disabled={form.models.length <= 1}
                        title={form.models.length <= 1 ? "至少保留一个模型" : `删除模型 ${model.id || index + 1}`}
                        aria-label={`删除模型 ${model.id || index + 1}`}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            models: current.models.filter((item) => item.key !== model.key),
                          }))
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                    <div className="ui-form__grid">
                      <Field label="模型 ID">
                        <input
                          className="ui-input"
                          required={index === 0}
                          value={model.id}
                          onChange={(e) => setModel(model.key, { id: e.target.value })}
                          placeholder="coder"
                        />
                      </Field>
                      <Field label="显示名（可选）">
                        <input
                          className="ui-input"
                          value={model.name}
                          onChange={(e) => setModel(model.key, { name: e.target.value })}
                          placeholder="默认与 ID 相同"
                        />
                      </Field>
                    </div>
                    <Disclosure
                      title="高级"
                      meta={[
                        model.sdk ? sdkShort(model.sdk) : "",
                        model.supportsImages ? "图片" : "",
                        model.variants.length ? `${model.variants.length} 档` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "接口跟随供应商"}
                      defaultOpen={modelAdvancedOpen(model, index)}
                    >
                      <Field label="接口">
                        <Select
                          className="ui-input"
                          value={model.sdk}
                          onValueChange={(nextValue) => setModel(model.key, { sdk: nextValue })}
                        >
                          <option value="">
                            跟随供应商
                            {sdkShort(form.npm) ? `（${sdkShort(form.npm)}）` : ""}
                          </option>
                          {SDK_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                          {sdkExtraOption(model.sdk)}
                        </Select>
                      </Field>
                      <div className="ui-switch-row">
                        <Switch
                          checked={model.supportsImages === true}
                          onChange={(next) => setModel(model.key, { supportsImages: next })}
                          label={`模型 ${model.id || index + 1} 是否支持图片输入`}
                          title={model.supportsImages ? "关闭后将声明为纯文本输入" : "打开后将声明为可接收图片"}
                        />
                        <span className="ui-switch-row__text">
                          支持图片输入
                          <small>打开后图片不再被拦截。</small>
                        </span>
                      </div>
                      <Field
                        group
                        label="推理强度档位"
                        hint="无档位的模型不支持推理强度。"
                      >
                        {model.variants.length > 0 && (
                          <div className="ui-chip-list">
                            {model.variants.map((name) => (
                              <span key={name} className="ui-chip">
                                {name}
                                <button
                                  type="button"
                                  className="ui-chip__x"
                                  aria-label={`移除档位 ${name}`}
                                  title={`移除档位 ${name}`}
                                  onClick={() =>
                                    setModel(model.key, {
                                      variants: model.variants.filter((item) => item !== name),
                                    })
                                  }
                                >
                                  <X aria-hidden />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="ui-inline-add">
                          <input
                            className="ui-input"
                            value={model.variantInput}
                            onChange={(e) => setModel(model.key, { variantInput: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                addVariant(model.key);
                              }
                            }}
                            placeholder="例如 low，回车确认"
                            aria-label={`模型 ${model.id || index + 1} 新档位名称`}
                          />
                          <Button
                            type="button"
                            disabled={!model.variantInput.trim()}
                            onClick={() => addVariant(model.key)}
                          >
                            <Plus aria-hidden />
                            添加档位
                          </Button>
                        </div>
                      </Field>
                    </Disclosure>
                  </div>
                ))}
              </div>
              <div className="ui-actions ui-actions--start">
                <Button
                  size="sm"
                  type="button"
                  onClick={() =>
                    setForm((current) => ({ ...current, models: [...current.models, EMPTY_MODEL(nextKey())] }))
                  }
                >
                  <Plus aria-hidden />
                  添加模型
                </Button>
              </div>
            </Field>
          </div>
          <div className="ui-form-dialog__footer">
            <Button type="button" onClick={closeForm}>
              取消
            </Button>
            <Button type="submit" variant="primary" busy={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : "添加"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  ) : null;

  return (
    <>
      {!data && !error && <p className="ui-section__desc">正在读取 opencode.json…</p>}
      {error && <p className="ui-error">{error}</p>}
      {data && !data.online && (
        <Note>OpenCode 未运行，改动将在下次启动时生效。</Note>
      )}
      {toolbar}
      {data && renderList(data.global, "全局")}
      {data && defaultCwd && renderList(data.project, "本项目")}
      {formDialog}
    </>
  );
}
