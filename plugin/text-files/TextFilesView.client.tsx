import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  History,
  Home,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import { post } from "../../src/api";
import { SwrCache } from "../../src/swr-cache";
import { copyText } from "../../src/clipboard";
import { basename } from "../../src/format";
import { FileMarkdown } from "../../src/session/markdown";
import { ConfirmDialog } from "../../src/ui";
import type { ToolViewProps } from "../client-registry";
import type {
  FsEntry,
  FsFile,
  FsListing,
  FsWriteResult,
} from "./text-files.types";
import {
  forgetPath,
  movePath,
  parseRecentFiles,
  RECENT_FILES_KEY,
  rememberFile,
} from "./recent-files";

const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

/**
 * 目录列表缓存：进目录先画上次的列表，同时照常重新读取。键是请求时的路径
 * （首次打开没给路径时用 ""），也按服务端归一化后的路径各存一份。
 * 只留内存、最多 12 个目录：文件列表变化快，没必要落盘。
 */
const listingCache = new SwrCache<FsListing>({ ttlMs: 0, maxEntries: 12 });

interface DocState {
  path: string;
  text: string;
  saved: string;
  mtimeMs?: number;
  truncated: boolean;
  isNew: boolean;
  conflict: boolean;
}

function formatSize(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string) {
  const sep = dir.includes("\\") ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  if (!base) return dir.startsWith("/") ? `/${name}` : name;
  return `${base}${sep}${name}`;
}

export function TextFilesView({
  tool,
  initialCwd,
  directories,
  onToast,
}: ToolViewProps) {
  const [pathInput, setPathInput] = useState(
    initialCwd || directories[0] || tool.defaultCwd || "",
  );
  const [listing, setListing] = useState<FsListing | undefined>(
    () => listingCache.peek(pathInput)?.value,
  );
  const [doc, setDoc] = useState<DocState>();
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      return parseRecentFiles(
        JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || "[]"),
      );
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string>();
  const [creating, setCreating] = useState<"file" | "dir" | "">("");
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<{ entry: FsEntry; name: string }>();
  const [wrap, setWrap] = useState(true);
  const [preview, setPreview] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<FsEntry>();
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const loaded = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(recentFiles));
    } catch {
      // 私密模式或存储配额不足时，本次打开的记录仍留在内存中。
    }
  }, [recentFiles]);

  const run = useCallback(
    async <T = any,>(action: string, details: Record<string, unknown> = {}) =>
      post<T>(`/tools/${tool.id}/run`, { action, ...details }),
    [tool.id],
  );

  const load = useCallback(
    async (target?: string) => {
      setBusy("list");
      setError("");
      const cached = listingCache.peek(target || "")?.value;
      if (cached) setListing(cached);
      try {
        const result = await run<FsListing>(
          "list",
          target ? { path: target } : {},
        );
        listingCache.set(target || "", result);
        if (result.path !== (target || "")) listingCache.set(result.path, result);
        setListing(result);
        setPathInput(result.path);
        setCreating("");
        setNewName("");
      } catch (loadError: any) {
        setError(loadError?.message || "无法读取目录");
      } finally {
        setBusy("");
      }
    },
    [run],
  );

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load(pathInput || undefined);
    // 仅首次按初始目录加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const openFile = useCallback(
    async (target: string) => {
      setBusy("read");
      setError("");
      try {
        const file = await run<FsFile>("read", { path: target });
        setDoc({
          path: file.path,
          text: file.content,
          saved: file.content,
          mtimeMs: file.mtimeMs,
          truncated: file.truncated,
          isNew: false,
          conflict: false,
        });
        setRecentFiles((current) => rememberFile(current, file.path));
        setHistoryOpen(false);
        setPreview(false);
      } catch (openError: any) {
        setError(openError?.message || "无法读取文件");
        onToast(openError?.message || "无法读取文件");
      } finally {
        setBusy("");
      }
    },
    [onToast, run],
  );

  const dirty = Boolean(doc && doc.text !== doc.saved);

  const requestOpenFile = (target: string) => {
    if (busy) return;
    if (doc?.path === target) {
      setHistoryOpen(false);
      return;
    }
    if (dirty || doc?.isNew) {
      setPendingOpen(target);
      return;
    }
    void openFile(target);
  };

  const openEntry = (entry: FsEntry) => {
    if (busy) return;
    if (entry.kind === "dir") {
      setHistoryOpen(false);
      void load(entry.path);
    } else requestOpenFile(entry.path);
  };

  const save = useCallback(
    async (force = false) => {
      if (!doc || busy) return;
      setBusy("write");
      setError("");
      try {
        const result = await run<FsWriteResult>("write", {
          path: doc.path,
          content: doc.text,
          baseMtimeMs: doc.isNew ? undefined : doc.mtimeMs,
          create: doc.isNew || undefined,
          force: force || undefined,
        });
        if (result.status === "conflict") {
          setDoc((current) =>
            current ? { ...current, conflict: true } : current,
          );
          return;
        }
        setDoc((current) =>
          current
            ? {
                ...current,
                path: result.path,
                saved: current.text,
                mtimeMs: result.mtimeMs,
                isNew: false,
                conflict: false,
              }
            : current,
        );
        setRecentFiles((current) => rememberFile(current, result.path));
        onToast("已保存");
        if (listing?.path) void load(listing.path);
      } catch (saveError: any) {
        setError(saveError?.message || "保存失败");
        onToast(saveError?.message || "保存失败");
      } finally {
        setBusy("");
      }
    },
    [busy, doc, listing?.path, load, onToast, run],
  );

  const closeDoc = () => {
    if (!doc) return;
    if (doc.text !== doc.saved || doc.isNew) {
      setDiscardPrompt(true);
      return;
    }
    setDoc(undefined);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name || !listing?.path || busy) return;
    const target = joinPath(listing.path, name);
    if (creating === "dir") {
      setBusy("mkdir");
      setError("");
      try {
        await run("mkdir", { path: target });
        onToast("文件夹已创建");
        setCreating("");
        setNewName("");
        void load(listing.path);
      } catch (createError: any) {
        setError(createError?.message || "创建失败");
      } finally {
        setBusy("");
      }
      return;
    }
    if (listing.entries.some((entry) => entry.name === name)) {
      setError("同名条目已存在");
      return;
    }
    setDoc({
      path: target,
      text: "",
      saved: "",
      isNew: true,
      truncated: false,
      conflict: false,
    });
    setPreview(false);
    setCreating("");
    setNewName("");
    setError("");
  };

  const submitRename = async () => {
    const current = renaming;
    const name = current?.name.trim();
    if (!current || !name || name === current.entry.name || busy) {
      if (name === current?.entry.name) setRenaming(undefined);
      return;
    }
    setBusy("rename");
    setError("");
    try {
      const result = await run<{ path: string }>("rename", {
        path: current.entry.path,
        name,
      });
      onToast(`已重命名为 ${name}`);
      if (doc) {
        const nextPath = movePath(
          [doc.path],
          current.entry.path,
          result.path,
        )[0];
        if (nextPath !== doc.path) setDoc({ ...doc, path: nextPath });
      }
      setRecentFiles((files) =>
        movePath(files, current.entry.path, result.path),
      );
      setRenaming(undefined);
      if (listing?.path) void load(listing.path);
    } catch (renameError: any) {
      setError(renameError?.message || "重命名失败");
      onToast(renameError?.message || "重命名失败");
    } finally {
      setBusy("");
    }
  };

  const findNext = useCallback(() => {
    const textarea = textareaRef.current;
    const needle = findQuery;
    if (!textarea || !doc || !needle) return;
    const text = doc.text;
    const start = textarea.selectionEnd ?? 0;
    let index = text.toLowerCase().indexOf(needle.toLowerCase(), start);
    if (index < 0) index = text.toLowerCase().indexOf(needle.toLowerCase());
    if (index < 0) {
      onToast("没有匹配内容");
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(index, index + needle.length);
    // 让命中行滚进视野：先失焦再聚焦会触发浏览器原生滚动行为。
    textarea.blur();
    textarea.focus();
  }, [doc, findQuery, onToast]);

  const removeEntry = async () => {
    const entry = pendingDelete;
    if (!entry) return;
    setPendingDelete(undefined);
    setBusy("remove");
    setError("");
    try {
      await run("remove", { path: entry.path });
      onToast(`已删除 ${entry.name}`);
      if (doc?.path === entry.path) setDoc(undefined);
      setRecentFiles((files) => forgetPath(files, entry.path));
      if (listing?.path) void load(listing.path);
    } catch (removeError: any) {
      setError(removeError?.message || "删除失败");
      onToast(removeError?.message || "删除失败");
    } finally {
      setBusy("");
    }
  };

  const copyContent = async () => {
    if (!doc) return;
    onToast((await copyText(doc.text)) ? "内容已复制" : "复制失败");
  };

  const notifyCodeCopy = useCallback(() => onToast("代码已复制"), [onToast]);

  const entries = listing?.entries || [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    : entries;
  const docLines = doc ? doc.text.split("\n").length : 0;
  const isMarkdownDoc = Boolean(doc && MARKDOWN_FILE.test(doc.path));
  const showPreview = isMarkdownDoc && preview;

  return (
    <section
      className={`files-tool${doc ? " editing" : ""}`}
      aria-label="文本编辑器"
    >
      <div className="files-browser">
        <div className="files-toolbar">
          <button
            className="icon-btn"
            type="button"
            title="上级目录"
            disabled={!listing || listing.parent === null}
            onClick={() => void load(listing?.parent || undefined)}
          >
            <ArrowUp />
          </button>
          <button
            className="icon-btn"
            type="button"
            title="主目录"
            disabled={!listing}
            onClick={() => listing && void load(listing.home)}
          >
            <Home />
          </button>
          <label className="files-path">
            <input
              value={pathInput}
              list="files-tool-directories"
              aria-label="目录路径"
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pathInput.trim())
                  void load(pathInput.trim());
              }}
            />
            <datalist id="files-tool-directories">
              {directories.map((directory) => (
                <option key={directory} value={directory} />
              ))}
            </datalist>
          </label>
          <button
            className="icon-btn"
            type="button"
            title="刷新"
            disabled={Boolean(busy)}
            onClick={() => void load(listing?.path || pathInput || undefined)}
          >
            <RefreshCw className={busy === "list" ? "spin" : ""} />
          </button>
        </div>
        <div className="files-subbar">
          <div className="files-subbar-actions">
            <button
              type="button"
              className={historyOpen ? "active" : ""}
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <History /> 最近
              {recentFiles.length ? ` ${recentFiles.length}` : ""}
            </button>
            <button
              type="button"
              disabled={!listing?.path}
              onClick={() => {
                setCreating("file");
                setNewName("");
              }}
            >
              <FilePlus2 /> 新建文件
            </button>
            <button
              type="button"
              disabled={!listing?.path}
              onClick={() => {
                setCreating("dir");
                setNewName("");
              }}
            >
              <FolderPlus /> 新建文件夹
            </button>
          </div>
          {!historyOpen ? (
            <div className="files-subbar-filter">
              <input
                className="files-filter"
                value={filter}
                placeholder="筛选"
                aria-label="筛选条目"
                onChange={(event) => setFilter(event.target.value)}
              />
              <span>
                {entries.length
                  ? needle
                    ? `${visible.length}/${entries.length} 项`
                    : `${entries.length} 项`
                  : ""}
              </span>
            </div>
          ) : null}
        </div>
        {creating ? (
          <form
            className="files-create"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <input
              value={newName}
              autoFocus
              placeholder={creating === "dir" ? "新文件夹名称" : "新文件名称"}
              aria-label="名称"
              disabled={Boolean(busy)}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit" disabled={Boolean(busy) || !newName.trim()}>
              <Check /> 创建
            </button>
          </form>
        ) : null}
        {error ? <div className="error-banner files-error">{error}</div> : null}
        <div className="files-list" role="list">
          {historyOpen ? (
            recentFiles.length ? (
              recentFiles.map((path) => (
                <button
                  className="files-recent-row"
                  type="button"
                  role="listitem"
                  key={path}
                  title={path}
                  disabled={Boolean(busy)}
                  onClick={() => requestOpenFile(path)}
                >
                  <FileText />
                  <span className="files-row-name">
                    <b>{basename(path)}</b>
                    <small>{path}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="files-empty-list">还没有打开过文件</p>
            )
          ) : (
            visible.map((entry) =>
              renaming?.entry.path === entry.path ? (
                <form
                  className="files-create files-rename"
                  key={entry.path}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitRename();
                  }}
                >
                  <input
                    value={renaming.name}
                    autoFocus
                    aria-label="新名称"
                    disabled={Boolean(busy)}
                    onChange={(event) =>
                      setRenaming({ entry, name: event.target.value })
                    }
                  />
                  <button
                    type="submit"
                    disabled={Boolean(busy) || !renaming.name.trim()}
                  >
                    <Check />
                  </button>
                  <button
                    type="button"
                    aria-label="取消重命名"
                    onClick={() => setRenaming(undefined)}
                  >
                    <X />
                  </button>
                </form>
              ) : (
                <div
                  className="files-row"
                  key={entry.path}
                  role="listitem"
                  onClick={() => openEntry(entry)}
                >
                  {entry.kind === "dir" ? <Folder /> : <FileText />}
                  <span className="files-row-name">
                    <b>{entry.name}</b>
                    {entry.kind === "file" ? (
                      <small>{formatSize(entry.size)}</small>
                    ) : null}
                  </span>
                  <button
                    className="icon-btn files-row-btn"
                    type="button"
                    title="重命名"
                    disabled={Boolean(busy)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming({ entry, name: entry.name });
                    }}
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon-btn files-row-btn files-row-delete"
                    type="button"
                    title="删除"
                    disabled={Boolean(busy)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDelete(entry);
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              ),
            )
          )}
          {!historyOpen && listing && !entries.length ? (
            <p className="files-empty-list">此目录为空</p>
          ) : null}
          {!historyOpen && listing && entries.length > 0 && !visible.length ? (
            <p className="files-empty-list">没有匹配「{filter}」的条目</p>
          ) : null}
          {!historyOpen && !listing && !error ? (
            <p className="files-empty-list">正在加载…</p>
          ) : null}
        </div>
      </div>
      <div className="files-editor">
        {doc ? (
          <>
            <header className="files-doc-bar">
              <button
                className="icon-btn"
                type="button"
                title="关闭文件"
                disabled={Boolean(busy)}
                onClick={closeDoc}
              >
                <ArrowLeft />
              </button>
              <div className="files-doc-title">
                <b title={doc.path}>
                  {basename(doc.path)}
                  {dirty || doc.isNew ? <em>（未保存）</em> : null}
                </b>
                <small title={doc.path}>{doc.path}</small>
              </div>
              {isMarkdownDoc ? (
                <button
                  className={`icon-btn${showPreview ? " active" : ""}`}
                  type="button"
                  title={showPreview ? "返回编辑" : "Markdown 预览"}
                  aria-pressed={showPreview}
                  onClick={() =>
                    setPreview((on) => {
                      if (!on) setFindOpen(false);
                      return !on;
                    })
                  }
                >
                  <Eye />
                </button>
              ) : null}
              {showPreview ? null : (
                <>
                  <button
                    className="icon-btn"
                    type="button"
                    title="查找（Ctrl+F）"
                    onClick={() => setFindOpen((open) => !open)}
                  >
                    <Search />
                  </button>
                  <button
                    className={`icon-btn${wrap ? " active" : ""}`}
                    type="button"
                    title={wrap ? "关闭自动换行" : "开启自动换行"}
                    aria-pressed={wrap}
                    onClick={() => setWrap((on) => !on)}
                  >
                    <WrapText />
                  </button>
                </>
              )}
              <button
                className="icon-btn"
                type="button"
                title="复制全部内容"
                onClick={() => void copyContent()}
              >
                <Copy />
              </button>
              <button
                className="icon-btn files-save"
                type="button"
                title="保存"
                disabled={
                  Boolean(busy) ||
                  doc.truncated ||
                  (!dirty && !doc.isNew && !doc.conflict)
                }
                onClick={() => void save()}
              >
                <Save />
              </button>
            </header>
            {doc.truncated ? (
              <p className="files-note">
                文件超过 1MB，仅显示开头部分，为只读模式
              </p>
            ) : null}
            {doc.conflict ? (
              <div className="files-note files-conflict">
                <span>磁盘上的文件已被修改，保存将覆盖它</span>
                <div>
                  <button type="button" onClick={() => void openFile(doc.path)}>
                    重新载入
                  </button>
                  <button
                    type="button"
                    className="danger-btn"
                    disabled={Boolean(busy) || doc.truncated}
                    onClick={() => void save(true)}
                  >
                    <Save /> 覆盖保存
                  </button>
                </div>
              </div>
            ) : null}
            {findOpen && !showPreview ? (
              <form
                className="files-find"
                onSubmit={(event) => {
                  event.preventDefault();
                  findNext();
                }}
              >
                <input
                  value={findQuery}
                  autoFocus
                  placeholder="在文件中查找"
                  aria-label="查找内容"
                  onChange={(event) => setFindQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setFindOpen(false);
                    }
                  }}
                />
                <button type="submit" disabled={!findQuery.trim()}>
                  下一个
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭查找"
                  onClick={() => setFindOpen(false)}
                >
                  <X />
                </button>
              </form>
            ) : null}
            {showPreview ? (
              <div className="files-md">
                <FileMarkdown text={doc.text} onCopy={notifyCodeCopy} />
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                className={`files-textarea${wrap ? "" : " nowrap"}`}
                value={doc.text}
                readOnly={doc.truncated}
                spellCheck={false}
                aria-label="文件内容"
                onChange={(event) =>
                  setDoc((current) =>
                    current
                      ? { ...current, text: event.target.value }
                      : current,
                  )
                }
                onKeyDown={(event) => {
                  const mod = event.metaKey || event.ctrlKey;
                  if (mod && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void save(doc.conflict);
                  }
                  if (mod && event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    setFindOpen(true);
                  }
                  if (
                    event.key === "Escape" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    closeDoc();
                  }
                }}
              />
            )}
            <footer className="files-doc-meta">
              <span>{docLines} 行</span>
              <span>{doc.text.length} 字符</span>
              {doc.mtimeMs ? (
                <span>修改于 {new Date(doc.mtimeMs).toLocaleString()}</span>
              ) : null}
              {doc.truncated ? <span>只读</span> : null}
            </footer>
          </>
        ) : (
          <div className="files-placeholder">
            <FileText />
            <b>选择文件开始查看与编辑</b>
            <small>支持复制、粘贴、编辑并保存到宿主机</small>
            {recentFiles[0] ? (
              <button
                type="button"
                title={recentFiles[0]}
                disabled={Boolean(busy)}
                onClick={() => requestOpenFile(recentFiles[0])}
              >
                <History /> 打开上次文件：{basename(recentFiles[0])}
              </button>
            ) : null}
          </div>
        )}
      </div>
      {pendingDelete ? (
        <ConfirmDialog
          title="删除条目"
          body={
            <>
              确定删除 <code>{pendingDelete.path}</code> 吗？
              {pendingDelete.kind === "dir" ? "仅支持删除空目录。" : ""}
            </>
          }
          confirmLabel="删除"
          danger
          onConfirm={() => void removeEntry()}
          onClose={() => setPendingDelete(undefined)}
        />
      ) : null}
      {discardPrompt ? (
        <ConfirmDialog
          title="放弃修改"
          body="当前文件有未保存的修改，关闭后将丢失。"
          confirmLabel="放弃修改"
          danger
          onConfirm={() => {
            setDiscardPrompt(false);
            setDoc(undefined);
          }}
          onClose={() => setDiscardPrompt(false)}
        />
      ) : null}
      {pendingOpen ? (
        <ConfirmDialog
          title="放弃修改并打开文件"
          body="当前文件有未保存的修改，打开其他文件后将丢失。"
          confirmLabel="放弃修改"
          danger
          onConfirm={() => {
            const target = pendingOpen;
            setPendingOpen(undefined);
            void openFile(target);
          }}
          onClose={() => setPendingOpen(undefined)}
        />
      ) : null}
    </section>
  );
}
