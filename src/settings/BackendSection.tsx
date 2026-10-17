import { useEffect, useState, type ReactNode } from "react";
import { Copy, Search } from "lucide-react";
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
  scanAction,
  action,
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
  scanAction?: ReactNode;
  /** 路径行行尾的动作（如「应用并重启」），与路径同排；路径行常驻，
   * 按钮位置不再随是否选中版本来回跳。 */
  action?: ReactNode;
}) {
  const chosen = bins.find((item) => item.bin === selected);
  /** 正在生效的运行时：下拉里用 meta 标出来；自动选择命中它时标自动项。 */
  const usingBin = !loading && Boolean(effective) && effective !== command;
  const usingAuto = !loading && (!effective || effective === command);
  /** 路径行常驻：显式版本显示其路径，自动选择显示当前生效的路径，
   * 切换选项只改文字不改布局。 */
  const displayBin = selected || effective || command;
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
                selected ? "手动指定的 CLI" : "自动选择（系统 PATH）"
              }
              options={[
                {
                  value: "",
                  label: "自动选择（系统 PATH）",
                  hint: command,
                  meta: usingAuto ? "使用中" : undefined,
                },
                ...bins.map((item) => {
                  const source = SOURCE_LABEL[item.source] || item.source;
                  const inUse = usingBin && effective === item.bin;
                  return item.version
                    ? {
                        // 版本与来源并进标签：触发器直接读出「v… · npm 全局」，
                        // 列表里不再重复显示 meta 徽标（「使用中」除外）。
                        value: item.bin,
                        label: `v${item.version} · ${source}`,
                        hint: item.bin,
                        meta: inUse ? "使用中" : undefined,
                      }
                    : {
                        value: item.bin,
                        label: "版本未知",
                        meta: inUse ? "使用中" : source,
                        hint: item.bin,
                      };
                }),
              ]}
            />
          </div>
          {onScan ? (
            <Button
              size="sm"
              disabled={disabled}
              title="重新探测已安装版本"
              aria-label="探测已安装版本"
              onClick={onScan}
            >
              <Search className={loading ? "ui-spin" : undefined} />
              探测
            </Button>
          ) : null}
          {scanAction}
        </div>
      </Field>
      <div className="cli-row">
        <div className="cli-path">
          <span>{!selected || chosen ? "安装路径" : "已保存路径"}</span>
          <code title={displayBin}>{displayBin}</code>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label="复制安装路径"
            title="复制安装路径"
            onClick={async () =>
              onToast(
                (await copyText(displayBin))
                  ? "路径已复制"
                  : "复制失败，请手动复制路径",
              )
            }
          >
            <Copy />
          </Button>
        </div>
        {action}
      </div>
    </>
  );
}

type LocalAgent = "claude" | "opencode";

interface BinsResult {
  activeProtocol?: "v1" | "v2";
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
  onRestart,
}: {
  agent: LocalAgent;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  /**
   * 未换版本时「应用并重启」退化成的动作（重启当前运行时）：重启与换版本
   * 重启共用一个按钮。只在需要它的 Agent 上给；不给则沿用旧行为——
   * 无改动时按钮禁用。
   */
  onRestart?: () => Promise<void> | void;
}) {
  const cached = binsCache.get(agent);
  const [bins, setBins] = useState<CodexBinInfo[]>(cached?.bins || []);
  const [selected, setSelected] = useState(cached?.selected || "");
  const [saved, setSaved] = useState<string | undefined>(cached?.selected);
  const [effective, setEffective] = useState(cached?.effective || "");
  const [pinned, setPinned] = useState(cached?.pinned || false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeProtocol, setActiveProtocol] = useState(cached?.activeProtocol);
  const name = agent === "claude" ? "Claude Code" : "OpenCode";
  const [manualPath, setManualPath] = useState(false);
  /** 有缓存数据时复扫不再锁 UI，避免重进页面时控件集体变灰、内容闪变。 */
  const blocking = loading && bins.length === 0;

  const applyState = (result: BinsResult) => {
    setBins(result.bins);
    setSelected(result.selected);
    setSaved(result.selected);
    setEffective(result.effective);
    setPinned(result.pinned);
    setActiveProtocol(result.activeProtocol);
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

  const changed = selected !== saved;
  /** 按钮文案跟着是否有改动走：没换版本点它就是重启当前。 */
  const applyDisabled =
    pinned ||
    blocking ||
    saved === undefined ||
    (!changed && !onRestart);
  const applyLabel = saving ? "应用中…" : changed ? "应用并重启" : "重启";
  /** 运行中与已选择的版本对不上时提示（Codex 页同款；只在给了 onRestart
   * 的合并按钮页显示，从扫描结果本地推导版本号）。 */
  const versionOf = (bin: string) => {
    const found = bins.find((item) => item.bin === bin);
    return found?.version ? `v${found.version}` : bin;
  };
  const versionMismatch =
    Boolean(onRestart) &&
    !loading &&
    Boolean(effective) &&
    Boolean(selected) &&
    effective !== selected;

  const apply = async () => {
    // 未换版本：退化为重启当前（重启与换版本重启共用一个按钮）。
    if (!changed && onRestart) {
      setSaving(true);
      try {
        await onRestart();
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    try {
      const response = await put<{
        result: { reloaded: boolean; busyCount: number; error?: string };
        snapshot: Snapshot;
      }>(`/agents/${agent}/bin`, {
        bin: selected,
      });
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
      await load();
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
      {versionMismatch ? (
        <Note tone="warn" title="运行版本与选择的版本不一致">
          当前运行 {versionOf(effective)}，已选择 {versionOf(selected)}
          ；空闲后点「应用并重启」。
        </Note>
      ) : null}
      <Group pad>
        <CliVersionField
          name={name}
          command={agent}
          bins={bins}
          selected={selected}
          effective={effective}
          disabled={pinned || blocking || saving}
          loading={loading}
          onChange={(value) => {
            setSelected(value);
            setManualPath(false);
          }}
          onToast={onToast}
          onScan={() => void load()}
          scanAction={
            <Button
              size="sm"
              disabled={pinned || blocking || saving}
              aria-label="手动指定 CLI 路径"
              aria-expanded={manualPath}
              onClick={() => setManualPath((value) => !value)}
            >
              {manualPath ? "收起" : "手动指定"}
            </Button>
          }
          action={
            <Button
              variant="primary"
              busy={saving}
              disabled={applyDisabled}
              onClick={() => void apply()}
            >
              {applyLabel}
            </Button>
          }
        />
        {manualPath ? (
          <Field label="CLI 可执行文件路径">
            <input
              className="ui-input"
              aria-label={`${name} CLI 可执行文件路径`}
              value={selected}
              disabled={pinned || blocking || saving}
              placeholder="例如 /opt/demo/opencode/bin/opencode"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSelected(event.target.value)}
              onBlur={() => setSelected((value) => value.trim())}
            />
            <p className="ui-field__hint">
              填写 Deck 服务所在机器上的可执行文件完整路径（不是目录）。
              点击「应用并重启」验证并保存；留空则使用系统 PATH。
            </p>
          </Field>
        ) : null}
      </Group>
      {agent === "opencode" ? (
        <Note>
          根据所选 CLI 自动适配 V1 / V2。
          {activeProtocol ? `当前使用 ${activeProtocol.toUpperCase()}。` : ""}
        </Note>
      ) : null}
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
        binsCache.set("codex", {
          ...entry,
          selected,
          effective: selected || "codex",
        });
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
            已保存的 CLI
            路径不可用；重新扫描后选择其它版本，或选回「自动选择」。
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
          action={
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
          }
        />
      </Group>
    </Section>
  );
}
