import { useEffect, useMemo, useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { api, put } from "../api";
import {
  Badge,
  Button,
  Field,
  Group,
  Note,
  Row,
  Section,
  Switch,
} from "../kit";
import type { ModelInfo } from "../types";

type Scope = "project" | "global";

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
 * OpenCode 子代理设置：列表来自 `GET /agent`（离线时退化为配置文件里
 * 已声明的 agent 名），保存写入所选作用域的 opencode.json——项目与
 * 全局文件同一 schema，项目值覆盖全局值。
 *
 * OpenCode 的配置只在后端进程启动时读取：没能热应用的改动（或手改了
 * opencode.json）要「重载 OpenCode」才生效，重载只重启它的后端，不重启 Deck。
 */
export function OpenCodeAgentsSection({
  cwd,
  enabled = true,
  reloading,
  onReload,
}: {
  cwd?: string;
  /** OpenCode 是否已在「Agent」页启用；未启用时改动只落盘。 */
  enabled?: boolean;
  reloading?: boolean;
  onReload?: () => void;
}) {
  const [data, setData] = useState<OpenCodeConfigResponse | null>(null);
  const [scope, setScope] = useState<Scope>(cwd ? "project" : "global");
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{
    text: string;
    needsReload: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    api<OpenCodeConfigResponse>(
      `/agents/opencode/config${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`,
    )
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setDrafts({});
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || String(err));
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

  const scopeFile = scope === "project" ? data?.project : data?.global;

  const valueFor = (name: string): AgentDraft =>
    drafts[name] || draftFor(name, scopeFile);

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
      // 只提交与目标文件实际不同的行，避免把继承值误写进当前作用域。
      const agent: Record<
        string,
        { model?: string | null; disable?: boolean }
      > = {};
      for (const entry of names) {
        const draft = valueFor(entry.name);
        if (sameDraft(entry.name, draft, scopeFile)) continue;
        agent[entry.name] = {
          model: draft.model.trim() ? draft.model.trim() : null,
          disable: !draft.enabled,
        };
      }
      if (!Object.keys(agent).length) {
        setStatus({ text: "没有改动", needsReload: false });
        return;
      }
      const result = await put<{ path: string; applied: boolean }>(
        "/agents/opencode/config",
        {
          scope,
          ...(scope === "project" && cwd ? { directory: cwd } : {}),
          agent,
        },
      );
      setStatus(
        result.applied
          ? {
              text: `已写入 ${result.path} 并应用到运行中的 OpenCode`,
              needsReload: false,
            }
          : {
              text: `已写入 ${result.path}，重载 OpenCode 后生效`,
              needsReload: true,
            },
      );
      const refreshed = await api<OpenCodeConfigResponse>(
        `/agents/opencode/config${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`,
      );
      setData(refreshed);
      setDrafts({});
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  const reloadButton =
    onReload && enabled ? (
      <Button
        size="sm"
        busy={reloading}
        title="重启 OpenCode 后端并重新读取 opencode.json，不重启 Deck"
        onClick={onReload}
      >
        <RefreshCw className={reloading ? "ui-spin" : undefined} />
        {reloading ? "重载中…" : "重载 OpenCode"}
      </Button>
    ) : undefined;

  return (
    <>
      {!enabled && (
        <Note tone="warn" icon={<Info />}>
          OpenCode 当前未启用：改动只会写入
          opencode.json，到「Agent」页启用后生效。
        </Note>
      )}
      <Section
        title="OpenCode 子代理"
        desc={`写入所选作用域的 opencode.json（项目覆盖全局，格式一致）。${
          data && !data.online && enabled
            ? " OpenCode 未在运行，保存后下次启动生效。"
            : ""
        }`}
        actions={reloadButton}
      >
        {cwd && (
          <Field label="写入位置">
            <select
              className="ui-input"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as Scope);
                setDrafts({});
              }}
            >
              <option value="project">
                本项目（{data?.project?.path || `${cwd}/opencode.json`}）
              </option>
              <option value="global">
                全局（{data?.global?.path || "~/.config/opencode/opencode.json"}
                ）
              </option>
            </select>
          </Field>
        )}
        {!cwd && data?.global && (
          <p className="ui-section__desc">写入全局配置：{data.global.path}</p>
        )}
        {!data && !error && (
          <p className="ui-section__desc">正在读取 OpenCode 配置…</p>
        )}
        {names.length > 0 && (
          <Group>
            {names.map((entry) => {
              const draft = valueFor(entry.name);
              return (
                <Row
                  key={entry.name}
                  stack
                  dim={!draft.enabled}
                  title={entry.name}
                  badges={
                    entry.mode === "subagent" ? <Badge>子代理</Badge> : null
                  }
                  desc={entry.description}
                  side={
                    <>
                      <input
                        className="ui-input ui-input--model"
                        list="opencode-agent-models"
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
                        onChange={(next) =>
                          setDraft(entry.name, { enabled: next })
                        }
                      />
                    </>
                  }
                />
              );
            })}
          </Group>
        )}
        {data && names.length === 0 && (
          <p className="ui-section__desc">没有可配置的子代理。</p>
        )}
        <datalist id="opencode-agent-models">
          {models
            .filter((model) => model.model && model.model !== "default")
            .map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName}
              </option>
            ))}
        </datalist>
        <div className="ui-actions">
          <Button
            variant="primary"
            busy={saving}
            disabled={!data}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存子代理设置"}
          </Button>
        </div>
        {status && (
          <Note
            tone={status.needsReload ? "warn" : "ok"}
            icon={<Info />}
            action={
              status.needsReload && reloadButton ? reloadButton : undefined
            }
          >
            {status.text}
          </Note>
        )}
        {error && <p className="ui-error">{error}</p>}
      </Section>
    </>
  );
}
