import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
} from "lucide-react";
import { post } from "../../src/api";
import type { ToolViewProps } from "../client-registry";
import type { GitChange, GitSnapshot } from "./git.types";

const statusLabel: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  "?": "未跟踪",
};

function changeLabel(change: GitChange) {
  if (change.untracked) return "未跟踪";
  const code =
    change.worktreeStatus !== " " ? change.worktreeStatus : change.indexStatus;
  return statusLabel[code] || code;
}

export function GitView({
  tool,
  initialCwd,
  directories,
  onToast,
}: ToolViewProps) {
  const [cwd, setCwd] = useState(
    initialCwd || directories[0] || tool.defaultCwd || "",
  );
  const [snapshot, setSnapshot] = useState<GitSnapshot>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    if (!cwd && initialCwd) setCwd(initialCwd);
  }, [cwd, initialCwd]);

  const run = useCallback(
    async (action: string, details: Record<string, unknown> = {}) => {
      const target = cwd.trim();
      if (!target) return;
      setBusy(action);
      setError("");
      try {
        const next = await post<GitSnapshot>(`/tools/${tool.id}/run`, {
          action,
          cwd: target,
          ...details,
        });
        setSnapshot(next);
        setSelected(new Set());
        if (next.message) onToast(next.message);
        if (action === "commit") setCommitMessage("");
        if (action === "createBranch") {
          setBranchName("");
          setCreatingBranch(false);
        }
      } catch (runError: any) {
        const message = runError?.message || "Git 操作失败";
        setError(message);
        onToast(message);
      } finally {
        setBusy("");
      }
    },
    [cwd, onToast, tool.id],
  );

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void run("status");
  }, [run]);

  const changes = snapshot?.changes || [];
  const selectedChanges = useMemo(
    () => changes.filter((change) => selected.has(change.path)),
    [changes, selected],
  );
  const stagePaths = selectedChanges
    .filter((change) => change.unstaged)
    .map((change) => change.path);
  const unstagePaths = selectedChanges
    .filter((change) => change.staged)
    .map((change) => change.path);
  const stagedCount = changes.filter((change) => change.staged).length;
  const allSelected = changes.length > 0 && selected.size === changes.length;
  const disabled = Boolean(busy);

  if (snapshot && !snapshot.repository)
    return (
      <section className="git-tool git-empty" aria-label="Git 管理">
        <div className="git-directory-bar">
          <DirectoryInput
            cwd={cwd}
            directories={directories}
            disabled={disabled}
            onChange={setCwd}
          />
          <button
            className="icon-btn"
            type="button"
            title="刷新"
            disabled={disabled || !cwd.trim()}
            onClick={() => void run("status")}
          >
            <RefreshCw className={busy === "status" ? "spin" : ""} />
          </button>
        </div>
        <div className="git-empty-state">
          <GitBranch />
          <h2>这里还不是 Git 仓库</h2>
          <p>{cwd}</p>
          <button
            className="primary"
            type="button"
            disabled={disabled}
            onClick={() => void run("init")}
          >
            <Plus /> 初始化仓库
          </button>
        </div>
      </section>
    );

  return (
    <section className="git-tool" aria-label="Git 管理">
      <div className="git-directory-bar">
        <DirectoryInput
          cwd={cwd}
          directories={directories}
          disabled={disabled}
          onChange={setCwd}
        />
        <button
          className="icon-btn"
          type="button"
          title="刷新仓库状态"
          disabled={disabled || !cwd.trim()}
          onClick={() => void run("status")}
        >
          <RefreshCw className={busy === "status" ? "spin" : ""} />
        </button>
      </div>
      {error ? <div className="error-banner git-error">{error}</div> : null}
      <div className="git-workspace">
        <div className="git-changes-pane">
          <header className="git-repo-bar">
            <div className="git-branch-control">
              <GitBranch />
              <select
                value={
                  snapshot?.branch?.startsWith("detached@")
                    ? ""
                    : snapshot?.branch || ""
                }
                aria-label="当前分支"
                disabled={disabled || !snapshot?.branches.length}
                onChange={(event) =>
                  event.target.value &&
                  void run("switch", { branch: event.target.value })
                }
              >
                {snapshot?.branch?.startsWith("detached@") ? (
                  <option value="">{snapshot.branch}</option>
                ) : null}
                {(snapshot?.branches || []).map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
              <button
                className="icon-btn"
                type="button"
                title="新建分支"
                disabled={disabled}
                onClick={() => setCreatingBranch((current) => !current)}
              >
                <Plus />
              </button>
            </div>
            <div className="git-sync-actions">
              <span title="与上游分支的差异">
                ↓ {snapshot?.behind || 0} ↑ {snapshot?.ahead || 0}
              </span>
              <button
                className="icon-btn"
                type="button"
                title="获取远端信息"
                disabled={disabled || !snapshot?.remotes.length}
                onClick={() => void run("fetch")}
              >
                <Server />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="快进拉取"
                disabled={disabled || !snapshot?.remotes.length}
                onClick={() => void run("pull")}
              >
                <ArrowDownToLine />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="推送"
                disabled={disabled || !snapshot?.remotes.length}
                onClick={() => void run("push")}
              >
                <ArrowUpFromLine />
              </button>
            </div>
          </header>
          {creatingBranch ? (
            <form
              className="git-create-branch"
              onSubmit={(event) => {
                event.preventDefault();
                if (branchName.trim())
                  void run("createBranch", { branch: branchName.trim() });
              }}
            >
              <input
                value={branchName}
                autoFocus
                placeholder="新分支名称"
                aria-label="新分支名称"
                disabled={disabled}
                onChange={(event) => setBranchName(event.target.value)}
              />
              <button type="submit" disabled={disabled || !branchName.trim()}>
                <Check /> 创建
              </button>
            </form>
          ) : null}
          <div className="git-change-actions">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!changes.length}
                onChange={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(changes.map((change) => change.path)),
                  )
                }
              />
              <span>
                {changes.length ? `${changes.length} 个文件` : "工作区干净"}
              </span>
            </label>
            <div>
              <button
                type="button"
                disabled={disabled || !unstagePaths.length}
                onClick={() => void run("unstage", { paths: unstagePaths })}
              >
                <RotateCcw /> 取消暂存
              </button>
              <button
                type="button"
                disabled={disabled || !stagePaths.length}
                onClick={() => void run("stage", { paths: stagePaths })}
              >
                <Plus /> 暂存
              </button>
            </div>
          </div>
          <div className="git-change-list" role="list">
            {changes.length ? (
              changes.map((change) => (
                <label
                  className="git-change-row"
                  key={`${change.path}:${change.indexStatus}:${change.worktreeStatus}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(change.path)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        next.has(change.path)
                          ? next.delete(change.path)
                          : next.add(change.path);
                        return next;
                      })
                    }
                  />
                  <span
                    className={`git-status-code ${change.untracked ? "untracked" : ""}`}
                  >
                    {changeLabel(change)}
                  </span>
                  <span className="git-file-name">
                    <b>{change.path}</b>
                    {change.originalPath ? (
                      <small>原路径 {change.originalPath}</small>
                    ) : null}
                  </span>
                  <span className="git-file-state">
                    {change.staged ? <em>已暂存</em> : null}
                    {change.unstaged && !change.untracked ? (
                      <em>未暂存</em>
                    ) : null}
                  </span>
                </label>
              ))
            ) : (
              <div className="git-clean-state">
                <Check />
                <span>没有待提交的改动</span>
              </div>
            )}
          </div>
        </div>
        <aside className="git-commit-pane">
          <header>
            <GitCommitHorizontal />
            <span>创建提交</span>
            <b>{stagedCount}</b>
          </header>
          <textarea
            value={commitMessage}
            placeholder="提交说明"
            aria-label="提交说明"
            disabled={disabled}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <p>
            {stagedCount
              ? `${stagedCount} 个文件将进入本次提交`
              : "先从左侧选择并暂存文件"}
          </p>
          <button
            className="primary"
            type="button"
            disabled={disabled || !stagedCount || !commitMessage.trim()}
            onClick={() =>
              void run("commit", { message: commitMessage.trim() })
            }
          >
            <GitCommitHorizontal /> 提交
          </button>
          <dl>
            <div>
              <dt>仓库</dt>
              <dd title={snapshot?.root}>{snapshot?.root || "-"}</dd>
            </div>
            <div>
              <dt>远端</dt>
              <dd>{snapshot?.remotes.join(", ") || "未配置"}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function DirectoryInput({
  cwd,
  directories,
  disabled,
  onChange,
}: {
  cwd: string;
  directories: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <FolderOpen />
      <input
        value={cwd}
        list="git-tool-directories"
        disabled={disabled}
        aria-label="Git 工作目录"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id="git-tool-directories">
        {directories.map((directory) => (
          <option key={directory} value={directory} />
        ))}
      </datalist>
    </label>
  );
}
