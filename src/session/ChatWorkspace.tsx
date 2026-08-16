import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api, post } from "../api";
import { dedupeThreadLoad, readThreadCache } from "../cache";
import { displayText, sessionKey } from "../format";
import { ChatHeader } from "../layout/ChatHeader";
import { SessionToolbar } from "../layout/SessionToolbar";
import type {
  AgentCapabilities,
  Approval,
  ApprovalMode,
  ApprovalPolicy,
  ApprovalsReviewer,
  ClaudePermissionMode,
  Personality,
  Provider,
  SandboxMode,
  ThreadSummary,
} from "../types";
import { threadActionPath, threadPath } from "../agents";
import { approvalBelongsToThread } from "./approvals";
import {
  approvalMode,
  approvalModeLabel,
  settingsForApprovalMode,
  settingsForSandboxMode,
} from "../codexLabels";
import { RenderErrorBoundary } from "../ui";
import { Composer } from "./Composer";
import { CommandModal, type CommandModalKind } from "./CommandModal";
import { Timeline } from "./Timeline";
import {
  incompleteCommandHint,
  parseComposerCommand,
  type ComposerCommand,
} from "./commands";
import type { ComposerImage } from "./images";
import { readComposerDraft, writeComposerDraft } from "./drafts";
import { collectStreamedAgentMessages } from "./streaming";
import {
  loadedUserMessages,
  reconcilePendingUserMessages,
  type PendingUserMessage,
} from "./optimistic";
import {
  shouldKeepLoadedThread,
  shouldSurfaceThreadLoadError,
} from "./thread-load";
import { draftFromUserMessage } from "./user-message";

export function ChatWorkspace({
  thread,
  provider,
  agentName,
  capabilities,
  approvals,
  events,
  origin,
  searchTarget,
  onBack,
  onSnapshot,
  onSwitchProvider,
  onMenu,
  onSelectThread,
  onToast,
  onUsage,
  onTasks,
  onAppearance,
  onOpenOrigin,
}: {
  thread: ThreadSummary;
  provider?: Provider;
  agentName: string;
  capabilities: AgentCapabilities;
  approvals: Approval[];
  events: any[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  searchTarget?: {
    turnId?: string;
    itemId?: string;
    query: string;
    request: number;
  };
  onBack: () => void;
  onSnapshot: () => void;
  onSwitchProvider: () => void;
  onMenu: () => void;
  onSelectThread: (providerId: string, threadId: string) => void;
  onToast: (message: string) => void;
  onUsage: () => void;
  onTasks: () => void;
  onAppearance: () => void;
  onOpenOrigin?: () => void;
}) {
  const threadCacheKey = sessionKey(thread);
  const [full, setFull] = useState<any>(
    () => readThreadCache(threadCacheKey) || undefined,
  );
  const [draft, setDraft] = useState(() => readComposerDraft(threadCacheKey));
  const [pendingUsers, setPendingUsers] = useState<PendingUserMessage[]>([]);
  const [error, setError] = useState("");
  const [threadLoadSettled, setThreadLoadSettled] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [sending, setSending] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [commandModal, setCommandModal] = useState<CommandModalKind>();
  const fullRef = useRef(full);
  fullRef.current = full;
  const updateDraft = (next: typeof draft) => {
    setDraft(writeComposerDraft(threadCacheKey, next));
  };
  const load = useCallback(
    () =>
      dedupeThreadLoad(threadCacheKey, () => api(threadPath(thread)))
        .then((data) => {
          const next = shouldKeepLoadedThread(fullRef.current, data)
            ? fullRef.current
            : data;
          setFull(next);
          setPendingUsers((current) =>
            reconcilePendingUserMessages(
              Array.isArray(next?.turns) ? next.turns : [],
              current,
            ),
          );
          setError("");
        })
        .catch((err) => {
          if (shouldSurfaceThreadLoadError(fullRef.current))
            setError(err.message);
        })
        .finally(() => setThreadLoadSettled(true)),
    [threadCacheKey, thread.id, thread.providerId, thread.agentId],
  );
  useEffect(() => {
    setThreadLoadSettled(false);
    const cached = readThreadCache(threadCacheKey);
    fullRef.current = cached || undefined;
    setFull(cached || undefined);
    load();
  }, [load, threadCacheKey]);

  useEffect(() => {
    const event = events.at(-1);
    const method = String(event?.method || "");
    if (!method || method.endsWith("/delta")) return;
    if (event?.providerId && event.providerId !== thread.providerId) return;
    if ((event?.agentId || "codex") !== (thread.agentId || "codex")) return;
    if (event?.params?.threadId && event.params.threadId !== thread.id) return;
    const immediate = method === "turn/completed" || method === "error";
    if (immediate) {
      load();
      return;
    }
    const timer = window.setTimeout(() => load(), 300);
    return () => window.clearTimeout(timer);
  }, [events.length, load, thread.id, thread.providerId, thread.agentId]);
  const commandPath = (name: string) =>
    `/threads/${thread.providerId}/${thread.id}/${name}`;
  const runCommand = async (command: ComposerCommand) => {
    if (
      thread.agentId === "claude" &&
      !["status", "usage", "ps", "model", "permissions"].includes(command.kind)
    )
      throw new Error(`${agentName} 暂不支持这个 Codecks 命令`);
    if (command.kind === "compact" && !capabilities.sessionSettings)
      throw new Error(`${agentName} 暂不支持压缩上下文`);
    if (command.kind === "model" && !capabilities.models)
      throw new Error(`${agentName} 暂不支持从 Codecks 切换模型`);
    if (command.kind === "permissions" && !capabilities.sessionSettings)
      throw new Error(`${agentName} 暂不支持修改会话权限`);
    if (command.kind === "skills" && !capabilities.skills)
      throw new Error(`${agentName} 暂不支持 Skill 面板`);
    if (command.kind === "mcp" && !capabilities.mcp)
      throw new Error(`${agentName} 暂不支持 MCP 面板`);
    if (command.kind === "review" && !capabilities.review)
      throw new Error(`${agentName} 暂不支持代码审查命令`);
    if (command.kind === "shell" && !capabilities.shell)
      throw new Error(`${agentName} 暂不支持 Shell 命令`);
    if (command.kind === "compact") return compact();
    if (command.kind === "status") {
      const usage = thread.tokenUsage;
      const used =
        usage?.used != null
          ? `${usage.used}${usage.limit != null ? ` / ${usage.limit}` : ""}`
          : "未知";
      setStatusNote(
        [
          `模型 ${thread.model}${thread.reasoningEffort ? ` · ${thread.reasoningEffort}` : ""}`,
          thread.agentId === "claude"
            ? `权限 ${thread.permissionMode || "default"}`
            : `沙箱 ${thread.sandbox || "workspace-write"} · 审批 ${approvalModeLabel(thread.approvalPolicy, thread.approvalsReviewer)}`,
          `状态 ${thread.status}${thread.activeTurnId ? ` · Turn ${thread.activeTurnId}` : ""}`,
          `Fast ${thread.serviceTier === "fast" ? "开启" : "关闭"}`,
          thread.personality ? `性格 ${thread.personality}` : "",
          `上下文 ${used}`,
          provider?.name ? `供应商 ${provider.name}` : "",
          `目录 ${thread.cwd || "未知"}`,
          `Thread ${thread.id}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    if (command.kind === "usage") {
      onUsage();
      return;
    }
    if (command.kind === "ps") {
      onTasks();
      return;
    }
    if (command.kind === "model") {
      if (!command.model) {
        setCommandModal({ kind: "model" });
        return;
      }
      if (locked) throw new Error("任务运行中，暂时不能修改模型");
      await saveSettings({
        model: command.model,
        reasoningEffort: command.reasoningEffort,
      });
      return;
    }
    if (command.kind === "permissions") {
      if (thread.agentId === "claude") {
        if (command.sandbox || command.approvalMode)
          throw new Error("Claude 权限请在权限面板中选择");
        setCommandModal({ kind: "permissions" });
        return;
      }
      if (!command.sandbox && !command.approvalMode) {
        setCommandModal({ kind: "permissions" });
        return;
      }
      const sandboxes: SandboxMode[] = [
        "read-only",
        "workspace-write",
        "danger-full-access",
      ];
      const approvalModes: ApprovalMode[] = [
        "untrusted",
        "on-request",
        "auto-review",
        "never",
      ];
      if (!sandboxes.includes(command.sandbox as SandboxMode))
        throw new Error(
          "Sandbox 应为 read-only、workspace-write 或 danger-full-access",
        );
      if (
        command.approvalMode &&
        !approvalModes.includes(command.approvalMode as ApprovalMode)
      )
        throw new Error(
          "审批模式应为 untrusted、on-request、auto-review 或 never",
        );
      if (locked) throw new Error("任务运行中，暂时不能修改权限");
      const sandbox = command.sandbox as SandboxMode;
      await saveSettings(
        command.approvalMode
          ? settingsForApprovalMode(
              command.approvalMode as ApprovalMode,
              sandbox,
            )
          : settingsForSandboxMode(
              sandbox,
              approvalMode(thread.approvalPolicy, thread.approvalsReviewer),
            ),
      );
      return;
    }
    if (command.kind === "skills") {
      setCommandModal({ kind: "skills", query: command.query });
      return;
    }
    if (command.kind === "mention") {
      setCommandModal({ kind: "mention", query: command.query });
      return;
    }
    if (command.kind === "mcp") {
      setCommandModal({ kind: "mcp", verbose: command.verbose });
      return;
    }
    if (command.kind === "fast") {
      if (locked) throw new Error("任务运行中，暂时不能切换 Fast 模式");
      const enabled = command.enabled ?? thread.serviceTier !== "fast";
      const applied = await saveSettings({
        serviceTier: enabled ? "fast" : null,
      });
      if (applied) setStatusNote(`Fast 模式已${enabled ? "开启" : "关闭"}`);
      return;
    }
    if (command.kind === "review")
      return post(commandPath("review"), {
        target: command.target.type,
        branch: command.target.branch,
        sha: command.target.sha,
        title: command.target.title,
        instructions: command.target.instructions,
      });
    if (command.kind === "shell")
      return post(commandPath("shell"), { command: command.command });
    if (command.kind === "goal")
      return post(commandPath("goal"), { objective: command.objective });
    if (command.kind === "goal-clear")
      return post(commandPath("goal"), { objective: null });
    if (command.kind === "init") return post(commandPath("init"));
    if (command.kind === "plan") return post(commandPath("plan"));
    if (command.kind === "diff") return post(commandPath("diff"));
  };
  const submit = async (candidate: typeof draft, restoreOnFailure: boolean) => {
    const value = candidate.text.trim();
    if (sending || thread.compacting) return;
    const command = parseComposerCommand(value);
    const hint = incompleteCommandHint(value);
    if (!command && hint) {
      setError(hint);
      return;
    }
    if (!command && !value && !candidate.images.length) return;
    setSending(true);
    setError("");
    setStatusNote("");
    const pendingImages = candidate.images;
    const pendingId = `${threadCacheKey}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const loadedUserMessageCount = loadedUserMessages(
      Array.isArray(fullRef.current?.turns) ? fullRef.current.turns : [],
    ).length;
    if (restoreOnFailure) {
      if (command) updateDraft({ text: "", images: pendingImages });
      else updateDraft({ text: "", images: [] });
    }
    if (!command) {
      setPendingUsers((current) => [
        ...current,
        {
          id: pendingId,
          text: value,
          images: pendingImages,
          loadedUserMessageCount,
        },
      ]);
    }
    try {
      if (command) await runCommand(command);
      else
        await post(threadActionPath(thread, "turns"), {
          text: value,
          images: pendingImages.map((image) => ({
            url: image.url,
            name: image.name,
          })),
        });
    } catch (err: any) {
      if (!command) {
        setPendingUsers((current) =>
          current.filter((message) => message.id !== pendingId),
        );
        if (restoreOnFailure)
          updateDraft({ text: value, images: pendingImages });
      } else if (restoreOnFailure)
        updateDraft({ text: value, images: pendingImages });
      setError(err.message);
    } finally {
      setSending(false);
    }
  };
  const send = () => submit(draft, true);
  const readHistoryDraft = (item: any) => {
    const result = draftFromUserMessage(item);
    if (result.skippedImages) onToast("历史图片来自本机路径，请重新选择后发送");
    return result.draft;
  };
  const editUserMessage = (item: any) => {
    updateDraft(readHistoryDraft(item));
    setComposerFocusRequest((current) => current + 1);
  };
  const retryUserMessage = async (turnId: string, item: any) => {
    if (sending || locked || thread.compacting) return;
    const candidate = readHistoryDraft(item);
    const value = candidate.text.trim();
    if (!value && !candidate.images.length) return;
    setSending(true);
    setError("");
    try {
      const created = await post(commandPath("retry"), {
        turnId,
        text: value,
        images: candidate.images.map((image) => ({
          url: image.url,
          name: image.name,
        })),
      });
      onSelectThread(thread.providerId, created.id);
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };
  const compact = async () => {
    try {
      await post(`/threads/${thread.providerId}/${thread.id}/compact`);
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const saveSettings = async (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    approvalsReviewer?: ApprovalsReviewer;
    permissionMode?: ClaudePermissionMode;
    personality?: Personality;
    serviceTier?: string | null;
  }) => {
    try {
      await api(threadPath(thread), {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      });
      onSnapshot();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };
  const forkFrom = async (lastTurnId?: string) => {
    try {
      const created = await post(
        `/threads/${thread.providerId}/${thread.id}/fork`,
        lastTurnId ? { lastTurnId } : {},
      );
      onSelectThread(thread.providerId, created.id);
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const streamed =
    thread.status === "running" || thread.status === "waiting"
      ? collectStreamedAgentMessages(
          events,
          thread.providerId,
          thread.id,
          thread.activeTurnId,
          thread.agentId || "codex",
        )
      : [];
  const threadApprovals = approvals.filter((approval) =>
    approvalBelongsToThread(approval, thread),
  );
  const latestTurnError = full?.turns?.at?.(-1)?.error;
  const rawTaskError = displayText(
    thread.lastError || latestTurnError?.message,
  );
  const rawErrorInfo = thread.errorCode || latestTurnError?.codexErrorInfo;
  const taskErrorCode =
    typeof rawErrorInfo === "string"
      ? rawErrorInfo
      : rawErrorInfo && typeof rawErrorInfo === "object"
        ? Object.keys(rawErrorInfo)[0]
        : undefined;
  const taskError = rawTaskError
    ? taskErrorCode === "unauthorized"
      ? `登录状态已失效：${rawTaskError}`
      : rawTaskError
    : "";
  const locked =
    thread.status === "running" ||
    thread.status === "waiting" ||
    Boolean(thread.compacting);
  const usageLimit = String(taskErrorCode || "")
    .toLowerCase()
    .includes("usagelimit");
  const contextExceeded = String(taskErrorCode || "")
    .toLowerCase()
    .includes("contextwindow");
  const headerThread =
    !thread.tokenUsage && full?.tokenUsage
      ? { ...thread, tokenUsage: full.tokenUsage }
      : thread;
  return (
    <main className="chat">
      <ChatHeader
        thread={headerThread}
        provider={provider}
        agentName={agentName}
        pendingCount={threadApprovals.length}
        locked={locked}
        onBack={onBack}
        onMenu={onMenu}
        onSwitchProvider={onSwitchProvider}
        onAppearance={onAppearance}
        onTasks={onTasks}
      />
      <RenderErrorBoundary
        resetKey={thread.id}
        fallback={
          <div className="timeline">
            <p className="error-banner">
              这个会话的内容无法显示，可返回列表重试
            </p>
          </div>
        }
      >
        <Timeline
          thread={thread}
          turns={Array.isArray(full?.turns) ? full.turns : []}
          streamed={streamed}
          pendingUsers={pendingUsers}
          origin={origin}
          targetTurnId={searchTarget?.turnId}
          targetItemId={searchTarget?.itemId}
          targetRequest={searchTarget?.request}
          targetFallbackReady={threadLoadSettled}
          onCopy={() => onToast("已复制")}
          onForkFrom={
            capabilities.fork ? (turnId) => forkFrom(turnId) : undefined
          }
          onOpenOrigin={onOpenOrigin}
          onEditUserMessage={editUserMessage}
          onRetryUserMessage={capabilities.fork ? retryUserMessage : undefined}
          messageActionsDisabled={
            locked || sending || Boolean(thread.compacting)
          }
        />
      </RenderErrorBoundary>
      {taskError && (
        <div className="task-error" role="alert">
          <ShieldAlert />
          <div>
            <b>{agentName} 执行失败</b>
            <p>{taskError}</p>
            {taskErrorCode && <small>错误类型：{taskErrorCode}</small>}
            {contextExceeded && (
              <button className="primary" type="button" onClick={compact}>
                压缩上下文
              </button>
            )}
            {usageLimit && (
              <button className="primary" type="button" onClick={onUsage}>
                查看额度
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="error-banner">{error}</p>}
      {statusNote && (
        <pre className="command-status" role="status">
          {statusNote}
        </pre>
      )}
      <Composer
        thread={thread}
        text={draft.text}
        images={draft.images}
        sending={sending}
        onChange={(text) => updateDraft({ ...draft, text })}
        onImages={(images) => updateDraft({ ...draft, images })}
        onSend={send}
        onCommand={(command) =>
          void submit({ text: command, images: draft.images }, true)
        }
        onError={setError}
        onStop={() =>
          post(threadActionPath(thread, "interrupt"), {
            turnId: thread.activeTurnId,
          })
        }
        focusRequest={composerFocusRequest}
        sessionControls={
          capabilities.sessionSettings ? (
            <SessionToolbar
              thread={headerThread}
              locked={locked}
              onSettings={saveSettings}
              onCompact={compact}
            />
          ) : undefined
        }
      />
      {commandModal && (
        <CommandModal
          mode={commandModal}
          thread={thread}
          locked={locked}
          onSettings={saveSettings}
          onInsert={(text) => {
            updateDraft({ ...draft, text: `${draft.text}${text}` });
            setCommandModal(undefined);
            setComposerFocusRequest((current) => current + 1);
          }}
          onClose={() => setCommandModal(undefined)}
        />
      )}
    </main>
  );
}
