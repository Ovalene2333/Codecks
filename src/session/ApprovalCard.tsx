import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderOpen,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import type { Approval, ApprovalResolveBody, FileChange } from "../types";
import { agentName } from "../agents";
import { basename, displayText } from "../format";
import { Button } from "../kit";
import { FileDiff } from "./FileDiff";

export function defaultDecisions(approval: Approval) {
  const listed = approval.availableDecisions;
  if (listed?.length) return listed;
  if (approval.kind === "command" || approval.kind === "file" || !approval.kind)
    return ["decline", "accept", "acceptForSession"];
  return listed || [];
}

export interface AgentPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface ApprovalDraft {
  selectedPermissions?: Record<string, boolean>;
  answers?: { value: string; other: string }[];
}

type ApprovalAction = {
  id: string;
  label: string;
  body: ApprovalResolveBody;
  tone: "approve" | "reject" | "neutral";
};

/**
 * ACP session/request_permission 的 options：agent 给的每一档都渲染出来，
 * 点击回传 optionId。只认这个方法，避免把别的协议的 options 字段误当
 * ACP 选项。
 */
export function agentOptionList(approval: Approval): AgentPermissionOption[] {
  if (approval.request.method !== "session/request_permission") return [];
  const raw = approval.request.params?.options;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => ({
      optionId: String(entry?.optionId ?? ""),
      name: String(entry?.name || entry?.optionId || "选项"),
      kind: String(entry?.kind || ""),
    }))
    .filter((entry) => entry.optionId);
}

function approvalKind(approval: Approval) {
  return (
    approval.kind ||
    (approval.request.method?.includes("fileChange") ? "file" : "command")
  );
}

function approvalCommand(approval: Approval) {
  const params = approval.request.params || {};
  return (
    approval.command ||
    (typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.join(" ")
        : "")
  );
}

/** 卡片标题里的动作短语（不含 agent 名）：执行命令 / 修改文件 / … */
export function approvalActionLabel(approval: Approval) {
  const kind = approvalKind(approval);
  const params = approval.request.params || {};
  if (kind === "permission") return "请求权限";
  if (kind === "question") return "需要你回答";
  if (kind === "file") return "请求修改文件";
  if (params.permission?.permission === "external_directory")
    return "请求访问项目外目录";
  if (approval.networkApproval) return "请求网络访问";
  return "请求执行命令";
}

/**
 * 会话上下文：有会话名或目录时，卡片第一行改显示「类型 · 名称 · 项目」，
 * 第二行只留请求类型，第三行留下具体内容。没有上下文时保持原标题。
 */
export interface ApprovalSessionInfo {
  name?: string;
  cwd?: string;
  /** 有值时显示「打开会话」按钮。 */
  onOpen?: () => void;
}

/** 请求类型的短标签：访问外部目录 / 执行命令 / 修改文件 … */
export function approvalTypeLabel(approval: Approval) {
  const kind = approvalKind(approval);
  const params = approval.request.params || {};
  if (kind === "permission") return "请求额外权限";
  if (kind === "question") return "需要你回答";
  if (kind === "file") return "修改文件";
  if (params.permission?.permission === "external_directory")
    return "访问外部目录";
  if (approval.networkApproval) return "访问网络";
  return "执行命令";
}

/**
 * 命令/文件类审批的按钮档位：拒绝、允许一次，其余进「更多」。
 * 权限与问答有自己的表单，不走这里（返回 undefined）。
 */
export function approvalDecisionActions(approval: Approval) {
  const kind = approvalKind(approval);
  if (kind === "permission" || kind === "question") return undefined;
  const decisions = defaultDecisions(approval);
  // ACP（devin 等）把完整 options 透传过来时逐档渲染，点哪档回哪个
  // optionId——devin 一次会给 Allow/本会话/本项目/全局/bypass/拒绝等多档。
  const agentOptions = agentOptionList(approval);
  const actions: ApprovalAction[] = agentOptions.length
    ? agentOptions.map((option) => ({
        id: option.optionId,
        label: option.name,
        body: { optionId: option.optionId },
        tone: option.kind.startsWith("reject")
          ? "reject"
          : option.kind === "allow_once"
            ? "approve"
            : "neutral",
      }))
    : [
        ...(decisions.includes("decline")
          ? [
              {
                id: "decline",
                label: "拒绝",
                body: { decision: "decline" as const },
                tone: "reject" as const,
              },
            ]
          : decisions.includes("cancel")
            ? [
                {
                  id: "cancel",
                  label: "取消",
                  body: { decision: "cancel" as const },
                  tone: "reject" as const,
                },
              ]
            : []),
        ...(decisions.includes("accept")
          ? [
              {
                id: "accept",
                label: "允许一次",
                body: { decision: "accept" as const },
                tone: "approve" as const,
              },
            ]
          : []),
        ...(decisions.includes("acceptForSession")
          ? [
              {
                id: "acceptForSession",
                label: "本会话允许",
                body: { decision: "acceptForSession" as const },
                tone: "neutral" as const,
              },
            ]
          : []),
        ...(decisions.includes("allowForProject")
          ? [
              {
                id: "allowForProject",
                label: "此项目始终允许（会写入项目配置）",
                body: { decision: "allowForProject" as const },
                tone: "neutral" as const,
              },
            ]
          : []),
      ];
  const rejectAction =
    actions.find((action) => action.tone === "reject") ||
    (agentOptions.length
      ? {
          id: "cancel",
          label: "取消",
          body: { decision: "cancel" as const },
          tone: "reject" as const,
        }
      : undefined);
  const allowAction = actions.find((action) => action.tone === "approve");
  const extraActions = actions.filter(
    (action) => action.id !== rejectAction?.id && action.id !== allowAction?.id,
  );
  return { rejectAction, allowAction, extraActions };
}

/** 收起态单行摘要用：命令原文 / 文件数 / 动作短语，取最有信息量的一项。 */
export function approvalDetail(approval: Approval) {
  const command = approvalCommand(approval);
  if (command) return command;
  const params = approval.request.params || {};
  const changes: FileChange[] | undefined =
    approval.changes || params.fileChange?.changes || params.changes;
  if (Array.isArray(changes) && changes.length)
    return changes.length === 1
      ? String(changes[0]?.path || "1 个文件")
      : `${changes.length} 个文件`;
  return displayText(approval.reason || params.reason);
}

function samePath(a: string, b?: string) {
  const trim = (value: string) => value.replace(/[\\/]+$/, "");
  return Boolean(b) && trim(a) === trim(String(b));
}

/** 审批第一行：会话类型 · 名称 · 项目（点击可打开会话）。 */
function SessionLine({
  session,
  actor,
  aside,
}: {
  session: ApprovalSessionInfo;
  actor: string;
  aside?: ReactNode;
}) {
  const project = session.cwd ? basename(session.cwd) : "";
  return (
    <header className="approval-title approval-session-line">
      <div className="approval-session">
        <span className="approval-session-agent">{actor}</span>
        {session.name ? (
          <b className="approval-session-name" title={session.name}>
            {session.name}
          </b>
        ) : null}
        {project ? (
          <span className="approval-session-project" title={session.cwd}>
            {project}
          </span>
        ) : null}
      </div>
      {session.onOpen ? (
        <button
          type="button"
          className="approval-session-open"
          onClick={session.onOpen}
          aria-label={session.name ? `打开会话「${session.name}」` : "打开会话"}
          title={session.name ? `打开会话「${session.name}」` : "打开会话"}
        >
          <ExternalLink aria-hidden="true" />
        </button>
      ) : null}
      {aside ? <div className="approval-title-aside">{aside}</div> : null}
    </header>
  );
}

export function ApprovalCard({
  approval,
  onResolve,
  disabled = false,
  error,
  draft,
  onDraftChange,
  contextCwd,
  session,
  aside,
}: {
  approval: Approval;
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled?: boolean;
  error?: string;
  draft?: ApprovalDraft;
  onDraftChange?: (draft: ApprovalDraft) => void;
  /** 所在会话的工作目录：与请求目录相同时不再重复显示目录行。 */
  contextCwd?: string;
  /** 跨会话展示时传入会话信息，卡片改用「会话 / 类型 / 内容」三行结构。 */
  session?: ApprovalSessionInfo;
  /** 标题行右侧的容器控件（翻页、收起等），让容器不必再多占一行。 */
  aside?: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedExtra, setSelectedExtra] = useState<string>();
  const [copyLabel, setCopyLabel] = useState("复制");
  const moreRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (moreOpen) moreRef.current?.scrollIntoView({ block: "nearest" });
  }, [moreOpen]);
  const kind = approvalKind(approval);
  const params = approval.request.params || {};
  const changes: FileChange[] | undefined =
    approval.changes || params.fileChange?.changes || params.changes;
  const questions = approval.questions || params.questions || [];
  const permissionItems = permissionItemsFrom(
    approval.permissions || params.permissions,
  );
  const actor = agentName(undefined, approval);
  const rawCwd = displayText(approval.cwd || params.cwd);
  const cwd = samePath(rawCwd, contextCwd) ? "" : rawCwd;
  const hasSession = Boolean(session?.name || session?.cwd);

  if (kind === "permission")
    return (
      <PermissionApproval
        approval={approval}
        actor={actor}
        items={permissionItems}
        onResolve={onResolve}
        disabled={disabled}
        error={error}
        draft={draft}
        onDraftChange={onDraftChange}
        cwd={cwd}
        session={hasSession ? session : undefined}
        aside={aside}
      />
    );
  if (kind === "question")
    return (
      <QuestionApproval
        approval={approval}
        actor={actor}
        questions={questions}
        onResolve={onResolve}
        disabled={disabled}
        error={error}
        draft={draft}
        onDraftChange={onDraftChange}
        session={hasSession ? session : undefined}
        aside={aside}
      />
    );

  const decided = approvalDecisionActions(approval);
  const rejectAction = decided?.rejectAction;
  const allowAction = decided?.allowAction;
  const extraActions = decided?.extraActions || [];
  const selectedAction = extraActions.find(
    (action) => action.id === selectedExtra,
  );
  const title = `${actor} ${approvalActionLabel(approval)}`;
  const command = approvalCommand(approval);
  const reason = displayText(approval.reason || params.reason);
  return (
    <article
      className={`approval-card kind-${kind}${hasSession ? " has-session" : ""}`}
    >
      {hasSession ? (
        <>
          <SessionLine session={session!} actor={actor} aside={aside} />
          <p className="approval-type">{approvalTypeLabel(approval)}</p>
        </>
      ) : (
        <header className="approval-title">
          <span className="approval-icon" aria-hidden="true">
            <ShieldAlert />
          </span>
          <div>
            <b>{title}</b>
          </div>
          {aside ? <div className="approval-title-aside">{aside}</div> : null}
        </header>
      )}
      <div className="approval-content">
        {!hasSession && reason ? (
          <p className="approval-reason">{reason}</p>
        ) : null}
        {!hasSession && cwd ? (
          <p className="approval-cwd">
            <FolderOpen aria-hidden="true" />
            <span title={cwd}>{cwd}</span>
          </p>
        ) : null}
        {command ? (
          <div className="approval-command-wrap">
            <Terminal aria-hidden="true" />
            <pre className="approval-command">{command}</pre>
            <button
              type="button"
              className="approval-copy-command"
              aria-label="复制完整命令"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  setCopyLabel("已复制");
                } catch {
                  setCopyLabel("复制失败");
                }
              }}
            >
              <Copy aria-hidden="true" />
              {copyLabel}
            </button>
          </div>
        ) : null}
        {kind === "file" && (
          <>
            {Array.isArray(changes) && changes.length > 0 ? (
              <p className="approval-file-count">
                涉及 {changes.length} 个文件
              </p>
            ) : null}
            <FileDiff changes={changes} />
          </>
        )}
        {extraActions.length > 0 ? (
          <fieldset
            ref={moreRef}
            className="approval-more-options"
            hidden={!moreOpen}
          >
            <legend>更多授权选项</legend>
            {extraActions.map((action) => (
              <label key={action.id}>
                <input
                  type="radio"
                  name={`approval-${approval.id}`}
                  checked={selectedExtra === action.id}
                  disabled={disabled}
                  onChange={() => setSelectedExtra(action.id)}
                />
                <span>{action.label}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
      {error ? (
        <p className="approval-resolve-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approval-actions approval-command-actions">
        {rejectAction && !moreOpen ? (
          <Button
            busy={disabled}
            onClick={() => onResolve(approval.id, rejectAction.body)}
          >
            {rejectAction.label}
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        {extraActions.length > 0 ? (
          <Button
            busy={disabled}
            aria-label={moreOpen ? "返回" : "更多授权选项"}
            aria-expanded={moreOpen}
            title={moreOpen ? "返回" : "更多授权选项"}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span>{moreOpen ? "返回" : "更多"}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        {moreOpen ? (
          <Button
            variant={selectedAction?.tone === "reject" ? "default" : "primary"}
            busy={disabled}
            disabled={!selectedAction}
            title={selectedAction?.label}
            onClick={() =>
              selectedAction && onResolve(approval.id, selectedAction.body)
            }
          >
            确认所选操作
          </Button>
        ) : allowAction ? (
          <Button
            variant="primary"
            busy={disabled}
            title={allowAction.label}
            onClick={() => onResolve(approval.id, allowAction.body)}
          >
            <Check aria-hidden="true" />
            <span>{allowAction.label}</span>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function permissionItemsFrom(raw: unknown): PermissionItem[] {
  if (Array.isArray(raw))
    return raw.map((item: any) =>
      typeof item === "string"
        ? { key: item, name: item }
        : {
            key: String(item.name || item.id || "权限"),
            name: String(item.name || item.id || "权限"),
            granted: item.granted,
          },
    );
  if (!raw || typeof raw !== "object") return [];
  const profile = raw as Record<string, any>;
  const items: PermissionItem[] = [];
  if (profile.fileSystem || profile.file_system)
    items.push({ key: "fileSystem", name: "文件系统写入", granted: true });
  if (profile.network)
    items.push({
      key: "network",
      name: "网络访问",
      granted: profile.network.enabled !== false,
    });
  if (!items.length)
    items.push({ key: "extra", name: "额外权限", granted: true });
  return items;
}

function grantedPermissions(
  raw: unknown,
  items: PermissionItem[],
  selected: Record<string, boolean>,
) {
  if (Array.isArray(raw) || !raw || typeof raw !== "object")
    return items.map((item) => ({
      ...item,
      granted: Boolean(selected[item.key]),
    }));
  const profile = raw as Record<string, any>;
  const granted: Record<string, unknown> = {};
  if (selected.fileSystem && (profile.fileSystem || profile.file_system))
    granted.fileSystem = profile.fileSystem || profile.file_system;
  if (selected.network && profile.network) {
    granted.network = { ...profile.network, enabled: true };
  }
  if (selected.extra) Object.assign(granted, profile);
  return granted;
}

type PermissionItem = { key: string; name: string; granted?: boolean };

function PermissionApproval({
  approval,
  actor,
  items,
  onResolve,
  disabled,
  error,
  draft,
  onDraftChange,
  cwd,
  session,
  aside,
}: {
  approval: Approval;
  actor: string;
  items: PermissionItem[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled: boolean;
  error?: string;
  draft?: ApprovalDraft;
  onDraftChange?: (draft: ApprovalDraft) => void;
  cwd: string;
  session?: ApprovalSessionInfo;
  aside?: ReactNode;
}) {
  const raw = approval.permissions || approval.request.params?.permissions;
  const [localSelected, setLocalSelected] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        items.map((item) => [item.key, item.granted !== false]),
      ),
  );
  const selected = draft?.selectedPermissions || localSelected;
  const hasSelectedPermission = Object.values(selected).some(Boolean);
  const reason = displayText(
    approval.reason || approval.request.params?.reason,
  );
  const updateSelected = (next: Record<string, boolean>) => {
    setLocalSelected(next);
    onDraftChange?.({ ...draft, selectedPermissions: next });
  };
  return (
    <article
      className={`approval-card kind-permission${session ? " has-session" : ""}`}
    >
      {session ? (
        <>
          <SessionLine session={session} actor={actor} aside={aside} />
          <p className="approval-type">{approvalTypeLabel(approval)}</p>
        </>
      ) : (
        <header className="approval-title">
          <span className="approval-icon" aria-hidden="true">
            <ShieldAlert />
          </span>
          <div>
            <b>{actor} 请求权限</b>
          </div>
          {aside ? <div className="approval-title-aside">{aside}</div> : null}
        </header>
      )}
      <div className="approval-content">
        {reason ? <p className="approval-reason">{reason}</p> : null}
        {!session && cwd ? (
          <p className="approval-cwd">
            <FolderOpen aria-hidden="true" />
            <span title={cwd}>{cwd}</span>
          </p>
        ) : null}
        <div className="permission-list">
          {items.map((item) => (
            <label key={item.key}>
              <input
                type="checkbox"
                checked={Boolean(selected[item.key])}
                disabled={disabled}
                onChange={(event) =>
                  updateSelected({
                    ...selected,
                    [item.key]: event.target.checked,
                  })
                }
              />
              {item.name}
            </label>
          ))}
        </div>
        {!hasSelectedPermission ? (
          <p className="approval-permission-hint">未选择权限，将拒绝此次请求</p>
        ) : null}
      </div>
      {error ? (
        <p className="approval-resolve-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approval-actions">
        <Button
          variant={hasSelectedPermission ? "primary" : "default"}
          busy={disabled}
          onClick={() =>
            onResolve(approval.id, {
              permissions: grantedPermissions(raw, items, selected),
              scope: "turn",
            })
          }
        >
          {hasSelectedPermission ? "允许所选（本回合）" : "拒绝权限"}
        </Button>
        {hasSelectedPermission ? (
          <Button
            busy={disabled}
            onClick={() =>
              onResolve(approval.id, {
                permissions: grantedPermissions(raw, items, selected),
                scope: "session",
              })
            }
          >
            允许所选（本会话）
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function QuestionApproval({
  approval,
  actor,
  questions,
  onResolve,
  disabled,
  error,
  draft,
  onDraftChange,
  session,
  aside,
}: {
  approval: Approval;
  actor: string;
  questions: any[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled: boolean;
  error?: string;
  draft?: ApprovalDraft;
  onDraftChange?: (draft: ApprovalDraft) => void;
  session?: ApprovalSessionInfo;
  aside?: ReactNode;
}) {
  const items = questions;
  const [localAnswers, setLocalAnswers] = useState<
    { value: string; other: string }[]
  >(() => items.map(() => ({ value: "", other: "" })));
  const answers =
    draft?.answers?.length === items.length ? draft.answers : localAnswers;
  const updateAnswers = (next: { value: string; other: string }[]) => {
    setLocalAnswers(next);
    onDraftChange?.({ ...draft, answers: next });
  };
  const pickedLabels = (answer: { value: string }) =>
    answer.value
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
  const pick = (index: number, label: string, multiple?: boolean) =>
    updateAnswers(
      answers.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        if (!multiple)
          return row.value === label
            ? { ...row, value: "" }
            : { ...row, value: label };
        const picked = row.value.split(", ").filter(Boolean);
        const next = picked.includes(label)
          ? picked.filter((item) => item !== label)
          : [...picked, label];
        return { ...row, value: next.join(", ") };
      }),
    );
  const completed = items.filter((question, index) => {
    const answer = answers[index];
    if (!(question.options || []).length) return Boolean(answer.value.trim());
    const labels = pickedLabels(answer);
    if (!labels.length) return false;
    const selected = (question.options || []).filter((item: any) =>
      labels.includes(String(item.label ?? item.value)),
    );
    if (
      selected.length === labels.length &&
      !selected.some((item: any) => item.isOther)
    )
      return true;
    return Boolean(answer.other.trim());
  }).length;
  const ready = completed === items.length;
  return (
    <article
      className={`approval-card kind-question${session ? " has-session" : ""}`}
    >
      {session ? (
        <>
          <SessionLine session={session} actor={actor} aside={aside} />
          <p className="approval-type">
            {approvalTypeLabel(approval)}
            <small>
              已完成 {completed}/{items.length}
            </small>
          </p>
        </>
      ) : (
        <header className="approval-title">
          <span className="approval-icon" aria-hidden="true">
            <ShieldAlert />
          </span>
          <div>
            <b>{actor} 需要你回答</b>
            <small>
              已完成 {completed}/{items.length}
            </small>
          </div>
          {aside ? <div className="approval-title-aside">{aside}</div> : null}
        </header>
      )}
      <div className="approval-content">
        <div className="question-list">
          {items.map((question, index) => {
            const options = question.options || [];
            const answer = answers[index];
            const labels = pickedLabels(answer);
            const multiple = Boolean(
              approval.multiple || question.multiple || question.multiSelect,
            );
            const custom =
              question.custom === true ||
              Boolean(question.isOther) ||
              options.some(
                (item: any) =>
                  item.isOther &&
                  labels.includes(String(item.label ?? item.value)),
              ) ||
              (Boolean(options.length) &&
                labels.length > 0 &&
                !options.some((item: any) =>
                  labels.includes(String(item.label ?? item.value)),
                ));
            return (
              <section className="question-card" key={question.id || index}>
                <header className="question-head">
                  {items.length > 1 && (
                    <span className="question-index">{index + 1}</span>
                  )}
                  <div>
                    <b>
                      {question.header ||
                        question.prompt ||
                        `问题 ${index + 1}`}
                    </b>
                    {question.header &&
                    (question.question || question.prompt) ? (
                      <small>{question.question || question.prompt}</small>
                    ) : null}
                    {multiple ? <small>可多选</small> : null}
                  </div>
                </header>
                {options.length > 0 ? (
                  <div className="question-options">
                    {options.map((option: any) => {
                      const label = String(option.label ?? option.value ?? "");
                      const active = labels.includes(label);
                      return (
                        <button
                          type="button"
                          key={label}
                          className={`question-option ${active ? "selected" : ""}`}
                          disabled={disabled}
                          onClick={() => pick(index, label, multiple)}
                        >
                          <Check
                            className={`question-check ${active ? "" : "hidden"}`}
                          />
                          <span>
                            <b>{label}</b>
                            {option.description ? (
                              <small>{option.description}</small>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    className="question-other"
                    value={answer.value}
                    disabled={disabled}
                    placeholder="输入你的回答…"
                    onChange={(event) =>
                      updateAnswers(
                        answers.map((row, rowIndex) =>
                          rowIndex === index
                            ? { ...row, value: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                )}
                {(custom || question.custom === true) && options.length > 0 && (
                  <input
                    className="question-other"
                    value={answer.other}
                    disabled={disabled}
                    placeholder="其他…"
                    onChange={(event) =>
                      updateAnswers(
                        answers.map((row, rowIndex) =>
                          rowIndex === index
                            ? { ...row, other: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>
      {error ? (
        <p className="approval-resolve-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approval-actions">
        <Button
          variant="primary"
          busy={disabled}
          disabled={!ready}
          onClick={() =>
            onResolve(approval.id, {
              answers: items.map((question, index) => ({
                id: question.id,
                value: answers[index].value,
                values: pickedLabels(answers[index]),
                isOther: Boolean(
                  question.isOther || answers[index].other.trim(),
                ),
                other: answers[index].other || undefined,
              })),
            })
          }
        >
          提交回答
        </Button>
      </div>
    </article>
  );
}
