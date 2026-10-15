import { Select } from "../kit/Select";
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api, put } from "../api";
import { Button, Field, Group, Note, Row, Section, Seg } from "../kit";

type Rule = "ask" | "allow" | "deny";
type Scope = "global" | "project";

interface PermissionsFile {
  scope: Scope;
  path: string;
  exists: boolean;
  rules: Record<string, Rule>;
}

interface PermissionsResponse {
  online: boolean;
  global: PermissionsFile;
  project?: PermissionsFile;
}

/** 高危常用工具先行展示；其余已配置项自动跟上，还可手输补充。 */
const SUGGESTED_TOOLS = ["bash", "edit", "write"];

const RULE_LABEL: Record<"" | Rule, string> = {
  "": "跟随默认",
  ask: "每次询问",
  allow: "直接允许",
  deny: "直接拒绝",
};

const RULE_TONE: Record<"" | Rule, "off" | "warn" | "ok" | "error"> = {
  "": "off",
  ask: "warn",
  allow: "ok",
  deny: "error",
};

/**
 * OpenCode 工具免审：读写 opencode.json(c) 的 `permission` 段。
 * 未配置的工具走 OpenCode 默认行为；`所有工具`设为直接允许后不再有
 * 工具类审批（问答类不受影响），确认环境可信再开。保存后重载生效。
 */
export function OpenCodePermissionsSection({
  defaultCwd,
  onToast,
  onNeedsReload,
}: {
  defaultCwd?: string;
  onToast?: (message: string) => void;
  /** 保存成功后点亮 SettingsModal 的「OpenCode 有配置等待生效」提示条。 */
  onNeedsReload?: () => void;
}) {
  const [data, setData] = useState<PermissionsResponse | null>(null);
  const [scope, setScope] = useState<Scope>(defaultCwd ? "project" : "global");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [customTool, setCustomTool] = useState("");
  const [customRule, setCustomRule] = useState<Rule>("ask");

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<PermissionsResponse>(
        `/agents/opencode/permissions${defaultCwd ? `?directory=${encodeURIComponent(defaultCwd)}` : ""}`,
      );
      setData(result);
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, [defaultCwd]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const file = scope === "project" ? (data?.project ?? data?.global) : data?.global;
  const rules = file?.rules || {};
  const tools = [
    "*",
    ...SUGGESTED_TOOLS,
    ...Object.keys(rules).filter(
      (tool) => tool !== "*" && !SUGGESTED_TOOLS.includes(tool),
    ),
  ];

  const save = async (tool: string, rule: Rule | null) => {
    setSaving(tool);
    try {
      const result = await put<{ path: string; rules: Record<string, Rule> }>(
        "/agents/opencode/permissions",
        {
          scope,
          ...(scope === "project" && defaultCwd ? { directory: defaultCwd } : {}),
          tool,
          rule,
        },
      );
      setData((current) =>
        current
          ? {
              ...current,
              [scope]: current[scope]
                ? { ...current[scope]!, rules: result.rules }
                : current[scope],
            }
          : current,
      );
      const message = `已写入${scope === "project" ? "项目" : "全局"}配置，重载 OpenCode 后生效`;
      setNotice(message);
      onToast?.(message);
      onNeedsReload?.();
    } catch (err: any) {
      const message = err?.message || String(err);
      setError(message);
      onToast?.(message);
    } finally {
      setSaving(null);
    }
  };

  const addCustom = () => {
    const tool = customTool.trim();
    if (!tool) return;
    setCustomTool("");
    void save(tool, customRule);
  };

  return (
    <Section
      title="工具审批"
      desc="各工具的审批规则。"
      actions={
        defaultCwd ? (
          <Seg<Scope>
            label="权限写入位置"
            value={scope}
            onChange={setScope}
            items={[
              { value: "global", label: "全局" },
              { value: "project", label: "本项目" },
            ]}
          />
        ) : undefined
      }
    >
      {!data && !error && <p className="ui-section__desc">正在读取权限配置…</p>}
      {error && <p className="ui-error">{error}</p>}
      {!error && notice && <p className="ui-section__desc">{notice}</p>}
      {data && !data.online && <Note>OpenCode 未运行，改动将在下次启动时生效。</Note>}
      {rules["*"] === "allow" && (
        <Note tone="warn">所有工具已设为直接允许，不再询问；请确认环境可信。</Note>
      )}
      {data && (
        <Group>
          {tools.map((tool) => {
            const rule = rules[tool] || "";
            return (
              <Row
                key={tool}
                dot={RULE_TONE[rule]}
                title={tool === "*" ? "所有工具" : tool}
                desc={RULE_LABEL[rule]}
                descTitle={
                  tool === "*"
                    ? "permission.*：所有工具的默认规则"
                    : `permission.${tool}`
                }
                side={
                  <Select
                    className="ui-input"
                    aria-label={`${tool === "*" ? "所有工具" : tool}的审批规则`}
                    value={rule}
                    disabled={saving !== null}
                    onValueChange={(nextValue) =>
                      void save(tool, (nextValue || null) as Rule | null)
                    }
                  >
                    <option value="">跟随默认</option>
                    <option value="ask">每次询问</option>
                    <option value="allow">直接允许</option>
                    <option value="deny">直接拒绝</option>
                  </Select>
                }
              />
            );
          })}
        </Group>
      )}
      {data && (
        <Field label="补充工具" hint="如 webfetch。">
          <div className="ui-form__grid">
            <input
              className="ui-input"
              value={customTool}
              onChange={(e) => setCustomTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="工具名"
            />
            <Select
              className="ui-input"
              aria-label="新工具的审批规则"
              value={customRule}
              onValueChange={(nextValue) => setCustomRule(nextValue as Rule)}
            >
              <option value="ask">每次询问</option>
              <option value="allow">直接允许</option>
              <option value="deny">直接拒绝</option>
            </Select>
          </div>
          <div className="ui-actions">
            <Button size="sm" type="button" disabled={!customTool.trim() || saving !== null} onClick={addCustom}>
              <Plus aria-hidden />
              添加
            </Button>
          </div>
        </Field>
      )}
    </Section>
  );
}
