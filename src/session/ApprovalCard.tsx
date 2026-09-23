import { useMemo, useState } from "react";
import { Check, FolderOpen, ShieldAlert, Terminal } from "lucide-react";
import type { Approval, ApprovalResolveBody, FileChange } from "../types";
import { agentName } from "../agents";
import { displayText } from "../format";
import { FileDiff } from "./FileDiff";

export function defaultDecisions(approval: Approval) {
  const listed = approval.availableDecisions;
  if (listed?.length) return listed;
  if (approval.kind === "command" || approval.kind === "file" || !approval.kind)
    return ["decline", "accept", "acceptForSession"];
  return listed || [];
}

export function ApprovalCard({
  approval,
  onResolve,
  disabled = false,
}: {
  approval: Approval;
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled?: boolean;
}) {
  const kind =
    approval.kind ||
    (approval.request.method?.includes("fileChange") ? "file" : "command");
  const params = approval.request.params || {};
  const changes: FileChange[] | undefined =
    approval.changes || params.fileChange?.changes || params.changes;
  const questions = approval.questions || params.questions || [];
  const permissionItems = permissionItemsFrom(
    approval.permissions || params.permissions,
  );
  const actor = agentName(undefined, approval);

  if (kind === "permission")
    return (
      <PermissionApproval
        approval={approval}
        actor={actor}
        items={permissionItems}
        onResolve={onResolve}
        disabled={disabled}
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
      />
    );

  const decisions = defaultDecisions(approval);
  const title =
    kind === "file"
      ? `${actor} 请求修改文件`
      : approval.networkApproval
        ? `${actor} 请求网络访问`
        : `${actor} 请求执行命令`;
  const command =
    approval.command ||
    (typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.join(" ")
        : "");
  const cwd = displayText(approval.cwd || params.cwd);
  const reason = displayText(approval.reason || params.reason);
  return (
    <article className={`approval-card kind-${kind}`}>
      <header className="approval-title">
        <span className="approval-icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <div>
          <b>{title}</b>
          <small>{reason || `请确认是否允许 ${actor} 继续执行`}</small>
        </div>
      </header>
      {cwd ? (
        <p className="approval-cwd">
          <FolderOpen aria-hidden="true" />
          <span>{cwd}</span>
        </p>
      ) : null}
      {command ? (
        <div className="approval-command-wrap">
          <Terminal aria-hidden="true" />
          <pre className="approval-command">{command}</pre>
        </div>
      ) : null}
      {kind === "file" && <FileDiff changes={changes} />}
      <div className="approval-actions">
        {decisions.includes("decline") && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve(approval.id, { decision: "decline" })}
          >
            拒绝
          </button>
        )}
        {decisions.includes("cancel") && !decisions.includes("decline") && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve(approval.id, { decision: "cancel" })}
          >
            取消
          </button>
        )}
        {decisions.includes("accept") && (
          <button
            type="button"
            disabled={disabled}
            className="approve"
            onClick={() => onResolve(approval.id, { decision: "accept" })}
          >
            <Check />
            允许一次
          </button>
        )}
        {decisions.includes("acceptForSession") && (
          <button
            type="button"
            disabled={disabled}
            className="approve session"
            onClick={() =>
              onResolve(approval.id, { decision: "acceptForSession" })
            }
          >
            本会话允许
          </button>
        )}
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
            key: String(item.name || item.id || "permission"),
            name: String(item.name || item.id || "permission"),
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
  return granted;
}

type PermissionItem = { key: string; name: string; granted?: boolean };

function PermissionApproval({
  approval,
  actor,
  items,
  onResolve,
  disabled,
}: {
  approval: Approval;
  actor: string;
  items: PermissionItem[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled: boolean;
}) {
  const raw = approval.permissions || approval.request.params?.permissions;
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((item) => [item.key, item.granted !== false])),
  );
  return (
    <article className="approval-card kind-permission">
      <header className="approval-title">
        <span className="approval-icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <div>
          <b>{actor} 请求权限</b>
          <small>选择本回合或本会话授予的权限</small>
        </div>
      </header>
      <div className="permission-list">
        {items.map((item) => (
          <label key={item.key}>
            <input
              type="checkbox"
              checked={Boolean(selected[item.key])}
              onChange={(event) =>
                setSelected((current) => ({
                  ...current,
                  [item.key]: event.target.checked,
                }))
              }
            />
            {item.name}
          </label>
        ))}
      </div>
      <div className="approval-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onResolve(approval.id, {
              permissions: grantedPermissions(raw, items, selected),
              scope: "turn",
            })
          }
        >
          本回合
        </button>
        <button
          type="button"
          disabled={disabled}
          className="approve session"
          onClick={() =>
            onResolve(approval.id, {
              permissions: grantedPermissions(raw, items, selected),
              scope: "session",
            })
          }
        >
          本会话
        </button>
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
}: {
  approval: Approval;
  actor: string;
  questions: any[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
  disabled: boolean;
}) {
  const items = questions.slice(0, 3);
  const [answers, setAnswers] = useState<{ value: string; other: string }[]>(
    () => items.map(() => ({ value: "", other: "" })),
  );
  const pickedLabels = (answer: { value: string }) =>
    answer.value
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
  const pick = (index: number, label: string, multiple?: boolean) =>
    setAnswers((current) =>
      current.map((row, rowIndex) => {
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
  const ready = useMemo(
    () =>
      items.every((question, index) => {
        const answer = answers[index];
        if (!(question.options || []).length)
          return Boolean(answer.value.trim());
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
      }),
    [answers, items],
  );
  return (
    <article className="approval-card kind-question">
      <header className="approval-title">
        <span className="approval-icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <div>
          <b>{actor} 需要你回答</b>
          <small>请完成下列问题后继续</small>
        </div>
      </header>
      <div className="question-list">
        {items.map((question, index) => {
          const options = question.options || [];
          const answer = answers[index];
          const labels = pickedLabels(answer);
          const multiple = Boolean(approval.multiple || question.multiple);
          const custom =
            question.custom === true ||
            Boolean(question.isOther) ||
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
                    {question.header || question.prompt || `问题 ${index + 1}`}
                  </b>
                  {question.header && (question.question || question.prompt) ? (
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
                  placeholder="输入你的回答…"
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((row, rowIndex) =>
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
                  placeholder="其他…"
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((row, rowIndex) =>
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
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          disabled={!ready || disabled}
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
        </button>
      </div>
    </article>
  );
}
