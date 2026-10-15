import { useEffect, useState, type ReactNode } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { api, put } from "../api";
import { copyText } from "../clipboard";
import { SearchablePicker } from "../SearchablePicker";
import { Button, Field, Group, Note, Section } from "../kit";
import type { Snapshot } from "../types";

type CodexBinInfo = {
  bin: string;
  version?: string;
  source: string;
  alive: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  env: "环境变量",
  path: "系统 PATH",
  standard: "标准位置",
  "npm-global": "npm 全局",
  "codex-packages": "CLI 安装目录",
  saved: "已保存",
};

function CliVersionField({
  name,
  command,
  bins,
  selected,
  effective,
  disabled,
  loading,
  onChange,
  onToast,
  onScan,
}: {
  name: string;
  command: string;
  bins: CodexBinInfo[];
  selected: string;
  effective: string;
  disabled: boolean;
  loading: boolean;
  onChange: (value: string) => void;
  onToast: (message: string) => void;
  /** 重新扫描已安装版本；收进 picker 行尾部的图标（MD3 列表补充动作），不再独立浮行。 */
  onScan?: () => void;
}) {
  const chosen = bins.find((item) => item.bin === selected);
  return (
    <>
      <Field label="运行版本">
        <div className="ui-inline-add">
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchablePicker
              ariaLabel={`${name} 运行版本`}
              value={selected}
              onChange={onChange}
              disabled={disabled}
              loading={loading}
              fallbackLabel={
                selected ? "已保存的版本不可用" : "自动选择（系统 PATH）"
              }
              options={[
                { value: "", label: "自动选择（系统 PATH）", hint: command },
                ...bins.map((item) => ({
                  value: item.bin,
                  label: item.version ? `v${item.version}` : "版本未知",
                  hint: item.bin,
                  meta: SOURCE_LABEL[item.source] || item.source,
                })),
              ]}
            />
          </div>
          {onScan ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              busy={loading}
              disabled={disabled}
              title="重新扫描已安装版本"
              aria-label="扫描已安装版本"
              onClick={onScan}
            >
              <RefreshCw className={loading ? "ui-spin" : undefined} />
            </Button>
          ) : null}
        </div>
      </Field>
      {selected && (
        <div className="cli-path">
          <span>{chosen ? "安装路径" : "已保存路径"}</span>
          <code>{selected}</code>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label="复制安装路径"
            title="复制安装路径"
            onClick={async () =>
              onToast(
                (await copyText(selected))
                  ? "路径已复制"
                  : "复制失败，请手动复制路径",
              )
            }
          >
            <Copy />
          </Button>
        </div>
      )}
      {effective && effective !== (chosen?.bin || selected || "") ? (
        <p className="ui-field__hint">
          生效中：<code>{effective || command}</code>
        </p>
      ) : null}
    </>
  );
}

type LocalAgent = "claude" | "opencode";

interface BinsResult {
  bins: CodexBinInfo[];
  selected: string;
  effective: string;
  pinned: boolean;
}

/** 扫描结果短缓存：重进设置页直接按上次结果渲染再后台复扫，布局不跳动。 */
const binsCache = new Map<string, BinsResult>();

export function LocalBackendSection({
  agent,
  onSaved,
  onToast,
  serviceRow,
}: {
  agent: LocalAgent;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  /** 嵌进同段顶部的服务状态行（如 OpenCode 的重载/重启行）——合并「服务」与「本机 CLI」两段。 */
  serviceRow?: ReactNode;
}) {
  const cached = binsCache.get(agent);
  const [bins, setBins] = useState<CodexBinInfo[]>(cached?.bins || []);
  const [selected, setSelected] = useState(cached?.selected || "");
  const [saved, setSaved] = useState<string | undefined>(cached?.selected);
  const [effective, setEffective] = useState(cached?.effective || "");
  const [pinned, setPinned] = useState(cached?.pinned || false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const name = agent === "claude" ? "Claude Code" : "OpenCode";
  const missing = Boolean(
    selected && !bins.some((item) => item.bin === selected),
  );
  /** 有缓存数据时复扫不再锁 UI，避免重进页面时控件集体变灰、内容闪变。 */
  const blocking = loading && bins.length === 0;

  const applyState = (result: BinsResult) => {
    setBins(result.bins);
    setSelected(result.selected);
    setSaved(result.selected);
    setEffective(result.effective);
    setPinned(result.pinned);
  };

  const load = async () => {
    setLoading(true);
    try {
      const result = await api<BinsResult>(`/agents/${agent}/bins`);
      binsCache.set(agent, result);
      applyState(result);
    } catch (err: any) {
      onToast(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const apply = async () => {
    setSaving(true);
    try {
      const response = await put<{
        result: { reloaded: boolean; busyCount: number; error?: string };
        snapshot: Snapshot;
      }>(`/agents/${agent}/bin`, { bin: selected });
      if (response.result.error) throw new Error(response.result.error);
      if (!response.result.reloaded) {
        onToast(
          `${name} 有 ${response.result.busyCount} 个会话正在运行或等待审批，空闲后再切换`,
        );
        return;
      }
      onSaved(response.snapshot);
      setEffective(selected || agent);
      setSaved(selected);
      const entry = binsCache.get(agent);
      if (entry)
        binsCache.set(agent, {
          ...entry,
          selected,
          effective: selected || agent,
        });
      onToast(`已应用 ${name} CLI 版本并重启`);
    } catch (err: any) {
      onToast(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="运行时"
      desc="服务进程与 CLI 版本；切换后仅重启此 Agent，有会话运行时不可切换。"
    >
      {pinned ? (
        <Note tone="warn">
          已由环境变量指定，无法在此修改；改完环境变量后重启 Deck。
        </Note>
      ) : null}
      <Group pad>
        {serviceRow}
        {missing && !loading ? (
          <p className="ui-field__hint" role="note">
            已保存的 CLI 路径不可用；重新扫描后选择其它版本，或选回「自动选择」。
          </p>
        ) : null}
        <CliVersionField
          name={name}
          command={agent}
          bins={bins}
          selected={selected}
          effective={effective}
          disabled={pinned || blocking || saving}
          loading={loading}
          onChange={setSelected}
          onToast={onToast}
          onScan={() => void load()}
        />
        <div className="ui-actions">
          <Button
            variant="primary"
            busy={saving}
            disabled={
              pinned ||
              blocking ||
              missing ||
              saved === undefined ||
              selected === saved
            }
            onClick={() => void apply()}
          >
            {saving ? "应用中…" : "应用并重启"}
          </Button>
        </div>
      </Group>
    </Section>
  );
}

/**
 * 本机后端：从服务端发现的 codex 二进制里选一个，下次重启 Runtime 生效。
 * 只提示版本不一致与残留旧后端，不自动杀进程（由用户手动重启/清理）。
 */
export function CodexBackendSection({
  runtime,
  onSaved,
  onToast,
}: {
  runtime?: Snapshot["runtime"];
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
}) {
  const cached = binsCache.get("codex");
  const [bins, setBins] = useState<CodexBinInfo[]>(cached?.bins || []);
  const [selected, setSelected] = useState(cached?.selected || "");
  const [saved, setSaved] = useState<string | undefined>(cached?.selected);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 有缓存数据时复扫不再锁 UI，避免重进页面时控件集体变灰、内容闪变。 */
  const blocking = loading && bins.length === 0;

  const load = async () => {
    setLoading(true);
    try {
      const result = await api<{
        bins: CodexBinInfo[];
        selected: string;
      }>("/runtime/codex-bins");
      const entry: BinsResult = {
        bins: result.bins || [],
        selected: result.selected || "",
        effective: result.selected || "codex",
        pinned: false,
      };
      binsCache.set("codex", entry);
      setBins(entry.bins);
      setSelected(entry.selected);
      setSaved(entry.selected);
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await put<Snapshot>("/runtime/codex-bin", { bin: selected }));
      setSaved(selected);
      const entry = binsCache.get("codex");
      if (entry)
        binsCache.set("codex", { ...entry, selected, effective: selected || "codex" });
      onToast("已应用 Codex CLI 版本；生效状态以实际运行的服务为准");
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  const mismatch = runtime?.codexVersionMismatch;
  const missing = Boolean(
    selected && !bins.some((item) => item.bin === selected),
  );
  const stale = runtime?.staleBackend;
  return (
    <Section
      title="运行时"
      desc="服务进程与 CLI 版本；切换后仅重启此 Agent，有会话运行时不可切换。"
    >
      {runtime?.codexBinPinned ? (
        <Note tone="warn">
          已由环境变量指定，无法在此修改；改完环境变量后重启 Deck。
        </Note>
      ) : null}
      {mismatch ? (
        <Note tone="warn" title="运行版本与选择的版本不一致">
          当前运行 {mismatch.running}，已选择 {mismatch.selected}
          ；空闲后点「应用并重启」。
        </Note>
      ) : null}
      {stale ? (
        <Note tone="warn" title="发现之前遗留的服务进程">
          进程号 {stale.pid}
          {stale.codexVersion ? `（${stale.codexVersion}）` : ""}{" "}
          还在运行，不会自动清理；确认无用请手动结束。
        </Note>
      ) : null}
      <Group pad>
        {missing && !loading && (
          <p className="ui-field__hint" role="note">
            已保存的 CLI 路径不可用；重新扫描后选择其它版本，或选回「自动选择」。
          </p>
        )}
        <CliVersionField
          name="Codex"
          command="codex"
          bins={bins}
          selected={selected}
          effective={runtime?.codexBinRunning || runtime?.codexBin || "codex"}
          disabled={Boolean(runtime?.codexBinPinned) || blocking || saving}
          loading={loading}
          onChange={setSelected}
          onToast={onToast}
          onScan={() => void load()}
        />
        <div className="ui-actions">
          <Button
            variant="primary"
            busy={saving}
            disabled={
              Boolean(runtime?.codexBinPinned) ||
              blocking ||
              missing ||
              saved === undefined ||
              (selected === saved && !mismatch && !stale)
            }
            onClick={() => void save()}
          >
            {saving ? "应用中…" : "应用并重启"}
          </Button>
        </div>
        {runtime?.codexVersionRunning ? (
          <p className="ui-section__desc">运行版本：v{runtime.codexVersionRunning}</p>
        ) : null}
      </Group>
    </Section>
  );
}
