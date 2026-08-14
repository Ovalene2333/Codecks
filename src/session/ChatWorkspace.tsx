import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api, post } from "../api";
import { dedupeThreadLoad, readThreadCache } from "../cache";
import { displayText, sessionKey } from "../format";
import { ChatHeader } from "../layout/ChatHeader";
import type {
  Approval,
  ApprovalPolicy,
  ApprovalResolveBody,
  Personality,
  Provider,
  SandboxMode,
  ThreadSummary,
} from "../types";
import { RenderErrorBoundary } from "../ui";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";
import {
  incompleteCommandHint,
  parseComposerCommand,
  type ComposerCommand,
} from "./commands";
import type { ComposerImage } from "./images";

export function ChatWorkspace({
  thread,
  provider,
  approvals,
  events,
  origin,
  onBack,
  onSnapshot,
  onSwitchProvider,
  onMenu,
  onSelectThread,
  onToast,
  onUsage,
  onOpenOrigin,
}: {
  thread: ThreadSummary;
  provider?: Provider;
  approvals: Approval[];
  events: any[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  onBack: () => void;
  onSnapshot: () => void;
  onSwitchProvider: () => void;
  onMenu: () => void;
  onSelectThread: (providerId: string, threadId: string) => void;
  onToast: (message: string) => void;
  onUsage: () => void;
  onOpenOrigin?: () => void;
}) {
  const threadCacheKey = sessionKey(thread);
  const [full, setFull] = useState<any>(
    () => readThreadCache(threadCacheKey) || undefined,
  );
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [error, setError] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [sending, setSending] = useState(false);
  const load = useCallback(
    () =>
      dedupeThreadLoad(threadCacheKey, () =>
        api(`/threads/${thread.providerId}/${thread.id}`),
      )
        .then(setFull)
        .catch((err) => setError(err.message)),
    [threadCacheKey, thread.id, thread.providerId],
  );
  useEffect(() => {
    const cached = readThreadCache(threadCacheKey);
    setFull(cached || undefined);
    load();
  }, [load, threadCacheKey]);

  useEffect(() => {
    const event = events.at(-1);
    const method = String(event?.method || "");
    if (!method || method.endsWith("/delta")) return;
    if (event?.params?.threadId && event.params.threadId !== thread.id) return;
    load();
  }, [events.length, load, thread.id]);
  const commandPath = (name: string) =>
    `/threads/${thread.providerId}/${thread.id}/${name}`;
  const runCommand = async (command: ComposerCommand) => {
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
          `沙箱 ${thread.sandbox || "workspace-write"} · 审批 ${thread.approvalPolicy || "on-request"}`,
          thread.personality ? `性格 ${thread.personality}` : "",
          `上下文 ${used}`,
          provider?.name ? `供应商 ${provider.name}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
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
  const send = async () => {
    const value = text.trim();
    if (sending || thread.compacting) return;
    const command = parseComposerCommand(value);
    const hint = incompleteCommandHint(value);
    if (!command && hint) {
      setError(hint);
      return;
    }
    if (!command && !value && !images.length) return;
    setSending(true);
    setError("");
    setStatusNote("");
    const pendingImages = images;
    if (command) setText("");
    else {
      setText("");
      setImages([]);
    }
    try {
      if (command) await runCommand(command);
      else
        await post(commandPath("turns"), {
          text: value,
          images: pendingImages.map((image) => ({
            url: image.url,
            name: image.name,
          })),
        });
    } catch (err: any) {
      if (!command) {
        setText(value);
        setImages(pendingImages);
      } else setText(value);
      setError(err.message);
    } finally {
      setSending(false);
    }
  };
  const resolve = async (id: string, body: ApprovalResolveBody) => {
    try {
      await post(`/approvals/${encodeURIComponent(id)}`, body);
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
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
    personality?: Personality;
  }) => {
    try {
      await api(`/threads/${thread.providerId}/${thread.id}`, {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      });
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
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
    thread.status === "running"
      ? events
          .filter(
            (event) =>
              event.params?.threadId === thread.id &&
              event.method === "item/agentMessage/delta" &&
              (!thread.activeTurnId ||
                event.params?.turnId === thread.activeTurnId),
          )
          .map((event) => event.params.delta)
          .join("")
      : "";
  const threadApprovals = approvals.filter(
    (approval) =>
      approval.request.params?.threadId === thread.id ||
      approval.id.startsWith(`${thread.id}:`),
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
  const locked = thread.status === "running" || thread.status === "waiting";
  const usageLimit =
    String(taskErrorCode || "").toLowerCase().includes("usagelimit");
  const contextExceeded = String(taskErrorCode || "")
    .toLowerCase()
    .includes("contextwindow");
  return (
    <main className="chat">
      <ChatHeader
        thread={thread}
        provider={provider}
        pendingCount={threadApprovals.length}
        locked={locked}
        onBack={onBack}
        onMenu={onMenu}
        onSwitchProvider={onSwitchProvider}
        onSettings={saveSettings}
        onCompact={compact}
      />
      <RenderErrorBoundary
        resetKey={thread.id}
        fallback={
          <div className="timeline">
            <p className="error-banner">这个会话的内容无法显示，可返回列表重试</p>
          </div>
        }
      >
        <Timeline
          thread={thread}
          turns={Array.isArray(full?.turns) ? full.turns : []}
          streamed={streamed}
          approvals={threadApprovals}
          origin={origin}
          onResolve={resolve}
          onCopy={() => onToast("已复制")}
          onForkFrom={(turnId) => forkFrom(turnId)}
          onOpenOrigin={onOpenOrigin}
        />
      </RenderErrorBoundary>
      {taskError && (
        <div className="task-error" role="alert">
          <ShieldAlert />
          <div>
            <b>Codex 执行失败</b>
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
        text={text}
        images={images}
        sending={sending}
        onChange={setText}
        onImages={setImages}
        onSend={send}
        onError={setError}
        onStop={() =>
          post(`/threads/${thread.providerId}/${thread.id}/interrupt`, {
            turnId: thread.activeTurnId,
          })
        }
      />
    </main>
  );
}
