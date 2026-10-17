import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  Globe,
  Play,
  Save,
  SquareTerminal,
  X,
} from "lucide-react";
import { post } from "../../src/api";
import { SwrCache } from "../../src/swr-cache";
import { copyText } from "../../src/clipboard";
import type { ToolViewProps } from "../client-registry";
import {
  commandParamNames,
  type QuickCommand,
  type QuickCommandResult,
} from "./quick-command.types";

/** 已保存的快捷指令：落盘缓存一份，打开工具页先画上次的列表再后台刷新。 */
const commandListCache = new SwrCache<QuickCommand[]>({
  persist: "quick-commands",
  ttlMs: 0,
  maxEntries: 1,
  maxPersistChars: 100_000,
});
const LIST_KEY = "list";

const fmtDuration = (ms: number) =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${(ms / 1_000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;

function statusLabel(result: QuickCommandResult) {
  if (result.timedOut) return "已超时";
  if (result.code === 0) return "完成";
  if (result.code !== null) return `退出码 ${result.code}`;
  return result.signal ? `已终止 ${result.signal}` : "已终止";
}

export function QuickCommandView({
  tool,
  initialCwd,
  directories,
  onToast,
}: ToolViewProps) {
  const [cwd, setCwd] = useState(
    initialCwd || directories[0] || tool.defaultCwd || "",
  );
  const [commands, setCommands] = useState<QuickCommand[]>(
    () => commandListCache.peek(LIST_KEY)?.value ?? [],
  );
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [bindCwd, setBindCwd] = useState(true);
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuickCommandResult>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const loaded = useRef(false);

  const paramNames = useMemo(() => commandParamNames(command), [command]);

  // 指令按绑定目录分组：当前目录组置顶，无目录的归入「通用」排最后。
  const groups = useMemo(() => {
    const map = new Map<string | undefined, QuickCommand[]>();
    for (const item of commands) {
      const list = map.get(item.cwd) || [];
      list.push(item);
      map.set(item.cwd, list);
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (a === cwd) return -1;
      if (b === cwd) return 1;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return (a || "").localeCompare(b || "");
    });
    return keys.map((key) => ({ key, items: map.get(key)! }));
  }, [commands, cwd]);

  useEffect(() => {
    if (!cwd && initialCwd) setCwd(initialCwd);
  }, [cwd, initialCwd]);

  const call = useCallback(
    <T,>(details: Record<string, unknown>) =>
      post<T>(`/tools/${tool.id}/run`, details),
    [tool.id],
  );

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    call<{ commands: QuickCommand[] }>({ action: "list" })
      .then((data) => {
        commandListCache.set(LIST_KEY, data.commands);
        setCommands(data.commands);
      })
      .catch((loadError: any) =>
        setError(loadError?.message || "快捷指令加载失败"),
      );
  }, [call]);

  const exec = useCallback(
    async (target?: {
      command: string;
      cwd: string;
      params: Record<string, string>;
    }) => {
      const cmd = (target?.command ?? command).trim();
      const dir = (target?.cwd ?? cwd).trim();
      if (!cmd) {
        setError("先输入要执行的指令");
        return;
      }
      if (!dir) {
        setError("先填写工作目录");
        return;
      }
      const values: Record<string, string> = {};
      for (const param of commandParamNames(cmd))
        values[param] = (target?.params ?? params)[param] ?? "";
      setBusy("exec");
      setError("");
      try {
        setResult(
          await call<QuickCommandResult>({
            action: "exec",
            cwd: dir,
            command: cmd,
            params: values,
          }),
        );
      } catch (runError: any) {
        const message = runError?.message || "指令执行失败";
        setError(message);
        onToast(message);
      } finally {
        setBusy("");
      }
    },
    [call, command, cwd, onToast, params],
  );

  const save = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setBusy("save");
    setError("");
    try {
      const data = await call<{ commands: QuickCommand[]; saved: QuickCommand }>(
        {
          action: "save",
          id: editingId,
          name: name.trim() || cmd.split(/\s+/)[0].slice(0, 24),
          command: cmd,
          cwd: bindCwd ? cwd.trim() || undefined : "",
        },
      );
      commandListCache.set(LIST_KEY, data.commands);
      setCommands(data.commands);
      setEditingId(data.saved.id);
      setName(data.saved.name);
      onToast("快捷指令已保存");
    } catch (saveError: any) {
      const message = saveError?.message || "保存失败";
      setError(message);
      onToast(message);
    } finally {
      setBusy("");
    }
  }, [call, command, cwd, bindCwd, editingId, name, onToast]);

  const removeCommand = useCallback(
    async (id: string) => {
      setBusy(`remove:${id}`);
      try {
        const data = await call<{ commands: QuickCommand[] }>({
          action: "remove",
          id,
        });
        commandListCache.set(LIST_KEY, data.commands);
        setCommands(data.commands);
        if (editingId === id) {
          setEditingId(undefined);
          setName("");
        }
        onToast("快捷指令已删除");
      } catch (removeError: any) {
        onToast(removeError?.message || "删除失败");
      } finally {
        setBusy("");
      }
    },
    [call, editingId, onToast],
  );

  const pick = useCallback(
    (item: QuickCommand) => {
      setEditingId(item.id);
      setName(item.name);
      setCommand(item.command);
      setBindCwd(Boolean(item.cwd));
      setParams({});
      const dir = item.cwd || cwd;
      if (item.cwd) setCwd(item.cwd);
      // 无占位符的一键直跑；带参数的先展开表单填参。
      if (!commandParamNames(item.command).length)
        void exec({ command: item.command, cwd: dir, params: {} });
    },
    [cwd, exec],
  );

  const copyOutput = async () => {
    if (!result) return;
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (!text) return;
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } else {
      onToast("复制失败，请检查浏览器权限");
    }
  };

  const disabled = Boolean(busy);

  return (
    <section className="qc-tool" aria-label="快捷指令">
      <div className="qc-directory-bar">
        <label>
          <FolderOpen />
          <input
            value={cwd}
            list="qc-directories"
            disabled={busy === "exec"}
            aria-label="工作目录"
            onChange={(event) => setCwd(event.target.value)}
          />
          <datalist id="qc-directories">
            {directories.map((directory) => (
              <option key={directory} value={directory} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="qc-body">
        {commands.length ? (
          <div className="qc-groups">
            {groups.map((group) => (
              <div
                className={`qc-group ${group.key === cwd ? "current" : ""}`}
                key={group.key || "__global"}
              >
                <button
                  type="button"
                  className="qc-group-head"
                  title={
                    group.key ? `切换到 ${group.key}` : "不绑定目录的通用指令"
                  }
                  disabled={!group.key}
                  onClick={() => group.key && setCwd(group.key)}
                >
                  {group.key ? <FolderOpen /> : <Globe />}
                  <span>{group.key || "通用"}</span>
                  {group.key === cwd ? <em>当前</em> : null}
                </button>
                <div className="qc-shortcuts" role="list">
                  {group.items.map((item) => (
                    <span
                      className={`qc-chip ${editingId === item.id ? "on" : ""}`}
                      key={item.id}
                      role="listitem"
                    >
                      <button
                        type="button"
                        className="qc-chip-run"
                        title={item.command}
                        disabled={disabled}
                        onClick={() => pick(item)}
                      >
                        <Play /> {item.name}
                      </button>
                      <button
                        type="button"
                        className="qc-chip-del"
                        title={`删除 ${item.name}`}
                        aria-label={`删除 ${item.name}`}
                        disabled={disabled}
                        onClick={() => void removeCommand(item.id)}
                      >
                        <X />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <form
          className="qc-form"
          onSubmit={(event) => {
            event.preventDefault();
            void exec();
          }}
        >
          <div className="qc-command-line">
            <SquareTerminal />
            <input
              value={command}
              placeholder="要执行的指令，可用 {参数名} 占位"
              aria-label="要执行的指令"
              disabled={busy === "exec"}
              onChange={(event) => setCommand(event.target.value)}
            />
            <button
              className="primary"
              type="submit"
              disabled={disabled || !command.trim() || !cwd.trim()}
            >
              <Play /> 执行
            </button>
          </div>
          {paramNames.length ? (
            <div className="qc-params">
              {paramNames.map((param) => (
                <label key={param}>
                  <span>{param}</span>
                  <input
                    value={params[param] || ""}
                    placeholder={`{${param}}`}
                    aria-label={`参数 ${param}`}
                    disabled={busy === "exec"}
                    onChange={(event) =>
                      setParams((current) => ({
                        ...current,
                        [param]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
          <div className="qc-save-row">
            <input
              value={name}
              placeholder="指令名称（保存用）"
              aria-label="指令名称"
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
            <label className="qc-scope" title="勾选后该指令归入当前目录分组">
              <input
                type="checkbox"
                checked={bindCwd}
                disabled={disabled}
                onChange={(event) => setBindCwd(event.target.checked)}
              />
              绑定当前目录
            </label>
            <button
              type="button"
              disabled={disabled || !command.trim()}
              onClick={() => void save()}
            >
              <Save /> {editingId ? "更新指令" : "存为快捷指令"}
            </button>
            {editingId ? (
              <button
                type="button"
                title="取消选择，回到新建模式"
                disabled={disabled}
                onClick={() => {
                  setEditingId(undefined);
                  setName("");
                }}
              >
                <X /> 新建
              </button>
            ) : null}
          </div>
        </form>
        {error ? <div className="error-banner qc-error">{error}</div> : null}
        {result ? (
          <div
            className={`qc-result ${result.code === 0 ? "ok" : "fail"}`}
            aria-live="polite"
          >
            <header>
              <code title={result.command}>$ {result.command}</code>
              <span className="qc-result-meta">
                {statusLabel(result)} · {fmtDuration(result.durationMs)}
                {result.truncated ? " · 输出已截断" : ""}
              </span>
              <button
                className="icon-btn"
                type="button"
                title="复制输出"
                disabled={!result.stdout && !result.stderr}
                onClick={() => void copyOutput()}
              >
                {copied ? <Check /> : <Copy />}
              </button>
            </header>
            {result.stdout ? (
              <pre className="qc-stdout">{result.stdout}</pre>
            ) : null}
            {result.stderr ? (
              <pre className="qc-stderr">{result.stderr}</pre>
            ) : null}
            {!result.stdout && !result.stderr ? (
              <p className="qc-hint">（无输出）</p>
            ) : null}
          </div>
        ) : (
          !error && (
            <p className="qc-hint qc-hint-block">
              {commands.length
                ? "点上面的快捷指令直接执行，或在输入框里写命令。"
                : "输入命令直接执行；需要反复用的指令可以存成快捷指令，{参数名} 会在执行前询问。"}
            </p>
          )
        )}
      </div>
    </section>
  );
}
