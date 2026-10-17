import { useEffect, useId, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { api, put } from "../api";
import {
  Button,
  Group,
  Note,
  Row,
  Section,
  Seg,
  Switch,
} from "../kit";
import type { ModelInfo } from "../types";
import { useDirtyFlag } from "../settings/dirty";
import { OpenCodePermissionsSection } from "./OpenCodePermissionsSection";

type Scope = "project" | "global";
/**
 * 代理设置的水平切换：三块都是 opencode.json 的写入面，天然平级——
 * 主 Agent / 子 Agent / 工具审批。一次只看一块，未保存草稿保留在
 * 各自挂载的组件里（hidden 包裹）。
 */
type AgentKind = "primary" | "subagent" | "permissions";

type AgentDraft = { enabled: boolean; model: string };

interface AgentEntry {
  name: string;
  mode?: string;
  description?: string;
  hidden?: boolean;
}

interface OpenCodeConfigResponse {
  online: boolean;
  global?: { path: string; exists: boolean; config: Record<string, any> };
  project?: { path: string; exists: boolean; config: Record<string, any> };
  agents?: AgentEntry[];
}

function scopedAgents(file?: { config: Record<string, any> }) {
  const agent = file?.config?.agent;
  return agent && typeof agent === "object" ? agent : {};
}

function draftFor(name: string, file?: { config: Record<string, any> }) {
  const entry = scopedAgents(file)[name] || {};
  return {
    enabled: !entry.disable,
    model: typeof entry.model === "string" ? entry.model : "",
  };
}

function sameDraft(
  name: string,
  draft: AgentDraft,
  file?: { config: Record<string, any> },
) {
  const current = draftFor(name, file);
  return current.enabled === draft.enabled && current.model === draft.model;
}

/**
 * 一组代理（主代理或子代理）的独立设置块：自带写入位置、草稿与保存，
 * 改子代理不再把主代理的保存按钮点亮，反之亦然。
 */
function AgentGroupSection({
  kind,
  title,
  cwd,
  data,
  entries,
  datalistId,
  onToast,
  onNeedsReload,
  onRefreshed,
}: {
  kind: "primary" | "subagent";
  title: string;
  cwd?: string;
  data: OpenCodeConfigResponse;
  entries: AgentEntry[];
  datalistId: string;
  onToast?: (message: string) => void;
  /** 保存返回 needsReload（未能在线热应用）时点亮全局提示条。 */
  onNeedsReload?: () => void;
  onRefreshed: (data: OpenCodeConfigResponse) => void;
}) {
  const [scope, setScope] = useState<Scope>(cwd ? "project" : "global");
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [error, setError] = useState("");
  /** 结果文本：外壳给了 toast 就把「已写入」的事实放 toast，正文保持安静。 */
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const scopeFile = scope === "project" ? data?.project : data?.global;

  const valueFor = (name: string): AgentDraft =>
    drafts[name] || draftFor(name, scopeFile);

  const dirty = entries.some(
    (entry) => drafts[entry.name] && !sameDraft(entry.name, drafts[entry.name], scopeFile),
  );
  useDirtyFlag(`agents:opencode:${cwd || "global"}:${kind}`, dirty);

  if (!entries.length) return null;

  const setDraft = (name: string, patch: Partial<AgentDraft>) =>
    setDrafts((current) => ({
      ...current,
      [name]: { ...valueFor(name), ...patch },
    }));

  async function save() {
    if (!data) return;
    setSaving(true);
    setError("");
    setStatus(null);
    try {
      // 只提交本组与目标文件实际不同的行，避免把继承值误写进当前作用域。
      const agent: Record<
        string,
        { model?: string | null; disable?: boolean }
      > = {};
      for (const entry of entries) {
        const draft = valueFor(entry.name);
        if (sameDraft(entry.name, draft, scopeFile)) continue;
        agent[entry.name] = {
          model: draft.model.trim() ? draft.model.trim() : null,
          disable: !draft.enabled,
        };
      }
      if (!Object.keys(agent).length) {
        onToast?.("没有改动");
        setStatus("没有改动");
        return;
      }
      const scopeText = scope === "project" ? "项目" : "全局";
      const result = await put<{ path: string; applied: boolean }>(
        "/agents/opencode/config",
        {
          scope,
          ...(scope === "project" && cwd ? { directory: cwd } : {}),
          agent,
        },
      );
      const message = result.applied
        ? `已写入${scopeText}配置并应用到运行中的 OpenCode`
        : `已写入${scopeText}配置，重载 OpenCode 后生效`;
      if (!result.applied) onNeedsReload?.();
      if (onToast) onToast(message);
      else setStatus(message);
      onRefreshed(
        await api<OpenCodeConfigResponse>(
          `/agents/opencode/config${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`,
        ),
      );
      setDrafts({});
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  const configPath =
    scope === "project"
      ? data?.project?.path || `${cwd}/opencode.json`
      : data?.global?.path || "opencode.json（全局配置目录）";

  const agentRow = (entry: AgentEntry) => {
    const draft = valueFor(entry.name);
    return (
      <Row
        key={entry.name}
        stack
        dim={!draft.enabled}
        title={entry.name}
        desc={entry.description}
        descTitle={entry.description}
        side={
          <>
            <input
              className="ui-input ui-input--model"
              list={datalistId}
              placeholder="模型：跟随默认"
              aria-label={`${entry.name} 的模型`}
              value={draft.model}
              onChange={(event) =>
                setDraft(entry.name, { model: event.target.value })
              }
            />
            <Switch
              checked={draft.enabled}
              label={`启用 ${entry.name}`}
              onChange={(next) => setDraft(entry.name, { enabled: next })}
            />
          </>
        }
      />
    );
  };

  return (
    <Section
      title={title}
      desc={
        <>
          写入 <code>{configPath}</code>
          {cwd ? "（项目覆盖全局）" : ""}
          。
        </>
      }
      actions={
        cwd ? (
          <Seg<Scope>
            label={`${title}写入位置`}
            value={scope}
            onChange={(next) => {
              setScope(next);
              setDrafts({});
            }}
            items={[
              { value: "project", label: "本项目" },
              { value: "global", label: "全局" },
            ]}
          />
        ) : undefined
      }
    >
      <div className="oc-rows">
        <Group>{entries.map(agentRow)}</Group>
      </div>
      {status && <p className="ui-section__desc">{status}</p>}
      {error && <p className="ui-error">{error}</p>}
      <div className="ui-actions">
        {dirty && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => setDrafts({})}
          >
            还原
          </Button>
        )}
        <Button
          variant="primary"
          busy={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : `保存${title}`}
        </Button>
      </div>
    </Section>
  );
}

/**
 * OpenCode 代理设置：主代理 / 子代理分开设置（各有写入位置与保存），
 * 权限另有独立的「工具审批」Section。列表来自 `GET /agent`（离线时退化为
 * 配置文件里已声明的 agent 名），保存写入所选作用域的 opencode.json——
 * 项目与全局文件同一 schema，项目值覆盖全局值。
 *
 * 生效反馈统一走 SettingsModal 顶部的 needsReload 提示条（保存的「已写入」
 * 结果有 toast 就走 toast，没 toast 的外壳才在正文里留一行状态）；
 * 服务重载走 Agent 列表，重启与版本切换共用运行时区的「应用并重启」，
 * 这里不再散落生命周期按钮。
 */
export function OpenCodeAgentsSection({
  cwd,
  enabled = true,
  onToast,
  onNeedsReload,
  onOpenProviders,
}: {
  cwd?: string;
  /** OpenCode 是否已在 Agent 列表里启用；未启用时改动只落盘。 */
  enabled?: boolean;
  onToast?: (message: string) => void;
  /** 保存返回 needsReload（未能在线热应用）时点亮全局提示条。 */
  onNeedsReload?: () => void;
  /** 跳转到「设置 → 供应商」管理 opencode.json 自定义供应商。 */
  onOpenProviders?: () => void;
}) {
  const [data, setData] = useState<OpenCodeConfigResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadError, setLoadError] = useState("");
  const datalistId = useId();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError("");
    api<OpenCodeConfigResponse>(
      `/agents/opencode/config${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`,
    )
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.message || String(err));
      });
    api<{ models?: ModelInfo[] } | ModelInfo[]>(
      `/agents/opencode/models${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`,
    )
      .then((result) => {
        if (cancelled) return;
        const list = Array.isArray(result) ? result : result?.models || [];
        setModels(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const names = useMemo(() => {
    const seen = new Map<string, AgentEntry>();
    for (const agent of data?.agents || []) {
      const name = String(agent?.name || "").trim();
      if (name) seen.set(name, { ...agent, name });
    }
    for (const file of [data?.project, data?.global]) {
      for (const name of Object.keys(scopedAgents(file))) {
        if (!seen.has(name)) seen.set(name, { name });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const primary = names.filter((entry) => entry.mode !== "subagent");
  const sub = names.filter((entry) => entry.mode === "subagent");
  const [kind, setKind] = useState<AgentKind>("primary");
  // 只有主代理或子代理的极端配置也可能空着：首载自动跳到非空的一组。
  useEffect(() => {
    if (kind === "primary" && !primary.length && sub.length) setKind("subagent");
  }, [kind, primary.length, sub.length]);
  const groupProps = {
    cwd,
    datalistId,
    onToast,
    onNeedsReload,
    onRefreshed: setData,
  };

  return (
    <>
      {!enabled && (
        <Note tone="warn" icon={<Info />}>
          OpenCode 当前未启用：修改仅写入配置文件，在 Agent 列表启用后生效。
        </Note>
      )}
      {/* 标签页是页面骨架，先于数据渲染；未保存草稿挂在下面的面板里。 */}
      <Seg<AgentKind>
        label="选择要配置的组"
        className="ui-seg--page"
        value={kind}
        onChange={setKind}
        items={[
          { value: "primary", label: "主 Agent" },
          { value: "subagent", label: "子 Agent" },
          { value: "permissions", label: "工具审批" },
        ]}
      />
      {onOpenProviders && (
        <div className="oc-link">
          <p className="ui-section__desc">
            自定义供应商在「设置 → 供应商 → OpenCode」管理。
          </p>
          <Button size="sm" variant="ghost" onClick={onOpenProviders}>
            去供应商页管理
          </Button>
        </div>
      )}
      {!data && !loadError && (
        <p className="ui-section__desc">正在读取 OpenCode 配置…</p>
      )}
      {loadError && <p className="ui-error">{loadError}</p>}
      {data && (
        <>
          {/* 三块都保持挂载：切走再切回，未保存的草稿不会丢。 */}
          <div hidden={kind !== "primary"}>
            <AgentGroupSection
              kind="primary"
              title="主 Agent"
              data={data}
              entries={primary}
              {...groupProps}
            />
            {primary.length === 0 && (
              <p className="ui-section__desc">没有主 Agent。</p>
            )}
          </div>
          <div hidden={kind !== "subagent"}>
            <AgentGroupSection
              kind="subagent"
              title="子 Agent"
              data={data}
              entries={sub}
              {...groupProps}
            />
            {sub.length === 0 && (
              <p className="ui-section__desc">没有子 Agent。</p>
            )}
          </div>
          <div hidden={kind !== "permissions"}>
            <OpenCodePermissionsSection
              onToast={onToast}
              onNeedsReload={onNeedsReload}
            />
          </div>
        </>
      )}
      <datalist id={datalistId}>
        {models
          .filter((model) => model.model && model.model !== "default")
          .map((model) => (
            <option key={model.id} value={model.model}>
              {model.displayName}
            </option>
          ))}
      </datalist>
    </>
  );
}
