import { useMemo, useState } from "react";
import { Check, FolderOpen, ShieldAlert, Terminal } from "lucide-react";
import type { Approval, ApprovalResolveBody, FileChange } from "../types";
import { displayText } from "../format";
import { FileDiff } from "./FileDiff";

function defaultDecisions(approval: Approval) {
  const listed = approval.availableDecisions;
  if (listed?.length) return listed;
  if (approval.kind === "command" || approval.kind === "file" || !approval.kind)
    return ["decline", "accept", "acceptForSession"];
  return listed || [];
}

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (id: string, body: ApprovalResolveBody) => void;
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

  if (kind === "permission")
    return (
      <PermissionApproval
        approval={approval}
        items={permissionItems}
        onResolve={onResolve}
      />
    );
  if (kind === "question")
    return (
      <QuestionApproval
        approval={approval}
        questions={questions}
        onResolve={onResolve}
      />
    );

  const decisions = defaultDecisions(approval);
  const title =
    kind === "file"
      ? "Codex 请求修改文件"
      : approval.networkApproval
        ? "Codex 请求网络访问"
        : "Codex 请求执行命令";
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
          <small>{reason || "请确认是否允许 Codex 继续执行"}</small>
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
            onClick={() => onResolve(approval.id, { decision: "decline" })}
          >
            拒绝
          </button>
        )}
        {decisions.includes("cancel") && !decisions.includes("decline") && (
          <button
            type="button"
            onClick={() => onResolve(approval.id, { decision: "cancel" })}
          >
            取消
          </button>
        )}
        {decisions.includes("accept") && (
          <button
            type="button"
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
  items,
  onResolve,
}: {
  approval: Approval;
  items: PermissionItem[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
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
          <b>Codex 请求权限</b>
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
  questions,
  onResolve,
}: {
  approval: Approval;
  questions: any[];
  onResolve: (id: string, body: ApprovalResolveBody) => void;
}) {
  const items = questions.slice(0, 3);
  const [answers, setAnswers] = useState<{ value: string; other: string }[]>(
    () => items.map(() => ({ value: "", other: "" })),
  );
  const ready = useMemo(
    () =>
      items.every((question, index) => {
        const answer = answers[index];
        if (!answer?.value) return false;
        const option = (question.options || []).find(
          (item: any) =>
            (item.value || item.label) === answer.value ||
            item.id === answer.value,
        );
        if (question.isOther || option?.isOther || answer.value === "other")
          return Boolean(answer.other.trim());
        return true;
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
          <b>Codex 需要你回答</b>
          <small>请完成下列问题后继续</small>
        </div>
      </header>
      {items.map((question, index) => {
        const options = question.options || [];
        const answer = answers[index];
        const selected = options.find(
          (item: any) =>
            (item.value || item.label) === answer.value ||
            item.id === answer.value,
        );
        const other =
          question.isOther || selected?.isOther || answer.value === "other";
        return (
          <label className="question-block" key={question.id || index}>
            {question.header ||
              question.prompt ||
              question.question ||
              `问题 ${index + 1}`}
            {options.length ? (
              <select
                value={answer.value}
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((row, rowIndex) =>
                      rowIndex === index
                        ? { ...row, value: event.target.value }
                        : row,
                    ),
                  )
                }
              >
                <option value="">选择一项</option>
                {options.map((option: any) => (
                  <option
                    key={option.value || option.label || option.id}
                    value={option.value || option.label || option.id}
                  >
                    {option.label || option.value || option.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={answer.value}
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
            {other && (
              <input
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
          </label>
        );
      })}
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          disabled={!ready}
          onClick={() =>
            onResolve(approval.id, {
              answers: items.map((question, index) => ({
                id: question.id,
                value: answers[index].value,
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
