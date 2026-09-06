import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AgentProfile,
  ModelInfo,
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
import { ConfirmDialog, RenderErrorBoundary } from "../ui";
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
import { collectStreamed } from "./streaming";
import {
  loadedUserMessages,
  reconcilePendingUserMessages,
  type PendingUserMessage,
} from "./optimistic";
import {
  shouldKeepLoadedThread,
  shouldSurfaceThreadLoadError,
} from "./thread-load";
import { draftFromUserMessage, userMessageText } from "./user-message";

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
  provider?: Provider | AgentProfile;
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
  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [opencodeCommands, setOpencodeCommands] = useState<
    Array<{ name: string; hint?: string }>
  >([]);
  const [revertConfirm, setRevertConfirm] = useState<
    { mode: "undo" | "redo" | "message"; messageID?: string; preview: string }
  >();
  const [reverting, setReverting] = useState(false);
  /**
   * 编辑后分支重发：点「从此重试」后不立即发送，而是把原文带回输入框、
   * 记住来源 turn；用户改完按发送才真正 fork + 重发，原分支完整保留。
   * 直接按发送即用原文重试，所以只多一次确认，可兼顾编辑与快捷。
   */
  const [retrySource, setRetrySource] = useState<
    { turnId: string; preview: string } | undefined
  >();
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
    // 切会话时上一个会话的分支重发意图一并丢弃，避免串到新会话。
    setRetrySource(undefined);
    load();
  }, [load, threadCacheKey]);
  useEffect(() => {
    if ((thread.agentId || "codex") !== "opencode") {
      setOpencodeCommands([]);
      return;
    }
    let cancelled = false;
    api<{ commands?: Array<{ name: string; description?: string }> }>(
      `${threadPath(thread)}/commands`,
    )
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.commands) ? data.commands : [];
        setOpencodeCommands(
          list
            .map((item) => ({
              name: String(item?.name || "").trim(),
              hint: String(item?.description || "").trim() || undefined,
            }))
            .filter((item) => Boolean(item.name)),
        );
      })
      .catch(() => {
        if (!cancelled) setOpencodeCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.agentId, thread.id, thread.providerId]);
  useEffect(() => {
    if ((thread.agentId || "codex") !== "opencode" || !thread.providerId) {
      setModelCatalog([]);
      return;
    }
    let cancelled = false;
    api<ModelInfo[]>(
      `/agents/opencode/models?providerId=${encodeURIComponent(thread.providerId)}`,
    )
      .then((list) => {
        if (!cancelled) setModelCatalog(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [thread.agentId, thread.providerId]);

  const latestEvent = events.at(-1);
  useEffect(() => {
    const event = latestEvent;
    const method = String(event?.method || "");
    if (!method || method.toLowerCase().endsWith("/delta")) return;
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
  }, [latestEvent, load, thread.id, thread.providerId, thread.agentId]);
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
    if (thread.agentId === "opencode") {
      if (command.kind === "compact") return compact();
      if (command.kind === "undo") {
        if (locked) throw new Error("任务运行中不能撤回，请先停止任务");
        setRevertConfirm({ mode: "undo", preview: lastUserPreview() });
        return;
      }
      if (command.kind === "redo") {
        if (locked) throw new Error("任务运行中不能恢复撤回，请先停止任务");
        setRevertConfirm({ mode: "redo", preview: "" });
        return;
      }
      if (command.kind === "opencode-command") {
        await post(`${threadPath(thread)}/commands`, {
          command: command.command,
          arguments: command.args,
        });
        onSnapshot();
        return;
      }
      if (command.kind === "new-session") {
        setStatusNote(
          `当前目录 ${thread.cwd || "未知"}\n点击左上角「新建会话」可开新 OpenCode 会话，历史会话在左侧列表按目录分组。`,
        );
        return;
      }
      if (command.kind === "sessions") {
        setStatusNote("左侧会话列表已按目录分组，直接点击即可切换 OpenCode 会话。");
        return;
      }
      if (command.kind === "thinking") {
        setStatusNote("思考过程默认折叠显示在时间线里，点击「思考过程」即可展开。");
        return;
      }
      if (command.kind === "details") {
        setStatusNote("工具执行细节保留在时间线里，点击对应工具卡即可展开查看入参与输出。");
        return;
      }
      if (command.kind === "help") {
        setStatusNote(
          [
            "OpenCode 命令：/compact /undo /redo /init /models /new /sessions /details /thinking",
            "/status /ps /usage，以及服务端自定义命令（输入 / 后补全可见）。",
            "分享类命令（/share 等）尚未接入，仍请用原生 TUI 执行。",
          ].join("\n"),
        );
        return;
      }
    }
    if (command.kind === "compact") return compact();
    if (command.kind === "status") {
      const usage = thread.tokenUsage;
      const used =
        usage?.used != null
          ? `${usage.used}${usage.limit != null ? ` / ${usage.limit}` : ""}`
          : "未知";
      setStatusNote(
        [
          `模型 ${thread.resolvedModel || thread.model}${thread.reasoningEffort ? ` · ${thread.reasoningEffort}` : ""}`,
          thread.agentId === "claude"
            ? `权限 ${thread.permissionMode || "default"}`
            : thread.agentId === "opencode"
              ? ""
              : `沙箱 ${thread.sandbox || "workspace-write"} · 审批 ${approvalModeLabel(thread.approvalPolicy, thread.approvalsReviewer)}`,
          `状态 ${thread.status}${thread.activeTurnId ? ` · Turn ${thread.activeTurnId}` : ""}`,
          thread.agentId === "opencode"
            ? ""
            : `Fast ${thread.serviceTier === "fast" ? "开启" : "关闭"}`,
          thread.personality && thread.agentId !== "opencode"
            ? `性格 ${thread.personality}`
            : "",
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
    const command = parseComposerCommand(value, thread.agentId || "codex");
    const hint = incompleteCommandHint(value);
    if (!command && hint) {
      setError(hint);
      return;
    }
    if (!command && !value && !candidate.images.length) return;
    // 分支重发意图下只接受正文发送；斜杠命令走正常链路并丢弃分支意图。
    const branchRetry = !command ? retrySource : undefined;
    if (command && retrySource) setRetrySource(undefined);
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
    if (branchRetry) {
      try {
        await executeRetrySend(branchRetry.turnId, candidate, pendingId);
      } catch (err: any) {
        if (restoreOnFailure)
          updateDraft({ text: value, images: pendingImages });
        setError(err.message);
      } finally {
        setSending(false);
      }
      return;
    }
    if (!command) {
      const pendingTurnId = thread.activeTurnId;
      const liveItemIds = pendingTurnId
        ? [
            ...new Set(
              events
                .filter(
                  (event) =>
                    event?.providerId === thread.providerId &&
                    (event?.agentId || "codex") ===
                      (thread.agentId || "codex") &&
                    event?.params?.threadId === thread.id &&
                    event?.params?.turnId === pendingTurnId,
                )
                .map(
                  (event) => event?.params?.item?.id || event?.params?.itemId,
                )
                .filter(Boolean)
                .map(String),
            ),
          ]
        : [];
      setPendingUsers((current) => [
        ...current,
        {
          id: pendingId,
          text: value,
          images: pendingImages,
          loadedUserMessageCount,
          turnId: pendingTurnId,
          liveItemIds,
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
  /** 纯编辑：把原文带回输入框追加为新 turn，不改变分支意图之外的状态。 */
  const editUserMessage = (item: any) => {
    setRetrySource(undefined);
    updateDraft(readHistoryDraft(item));
    setComposerFocusRequest((current) => current + 1);
  };
  const retryPath = (thread.agentId || "codex") === "opencode"
    ? `${threadPath(thread)}/retry`
    : commandPath("retry");
  /**
   * 从历史消息分支重试（两步式）：先把原文带回输入框并记住来源 turn，
   * 用户改完按发送才真正 fork + 重发；直接发送即用原文重试。
   * 原分支完整保留， destructive 的撤回（undo）只留给真正想抹掉历史时用。
   */
  const retryUserMessage = (turnId: string, item: any) => {
    if (sending || locked || thread.compacting) return;
    const candidate = readHistoryDraft(item);
    const preview = candidate.text.trim().slice(0, 42) || "所选消息";
    setRetrySource({ turnId, preview });
    updateDraft(candidate);
    setComposerFocusRequest((current) => current + 1);
  };
  const executeRetrySend = async (
    turnId: string,
    candidate: typeof draft,
    pendingId: string,
  ) => {
    const created = await post(retryPath, {
      turnId,
      text: candidate.text.trim(),
      images: candidate.images.map((image) => ({
        url: image.url,
        name: image.name,
      })),
    });
    setPendingUsers((current) =>
      current.filter((message) => message.id !== pendingId),
    );
    setRetrySource(undefined);
    onSelectThread(thread.providerId, created.id);
    onSnapshot();
  };
  const compact = async () => {
    try {
      if ((thread.agentId || "codex") === "opencode") {
        await post(`${threadPath(thread)}/compact`);
      } else {
        await post(`/threads/${thread.providerId}/${thread.id}/compact`);
      }
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    }
  };
  /** 确认框里展示的撤回目标：已加载历史里最后一条 user 消息，不足则兜底。 */
  const lastUserPreview = () => {
    const turns = Array.isArray(fullRef.current?.turns)
      ? fullRef.current.turns
      : [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const items = Array.isArray(turns[index]?.items) ? turns[index].items : [];
      const user = items.find((item: any) => item?.type === "userMessage");
      const text = user ? displayText(userMessageText(user)).trim() : "";
      if (text) return text.slice(0, 42);
    }
    return "最近一轮";
  };
  const executeRevert = async (messageID?: string) => {
    setReverting(true);
    try {
      const result = await post<{ messageID: string; files: number; additions: number; deletions: number }>(
        `${threadPath(thread)}/revert`,
        messageID ? { messageID } : {},
      );
      const files = Number(result?.files || 0);
      setStatusNote(
        [
          `已撤回${messageID ? "所选消息及之后" : "最近一轮"}的内容。`,
          files > 0
            ? `恢复 ${files} 个文件（+${result.additions} −${result.deletions}）。`
            : "未发现可恢复的文件快照，仅回滚了对话（非 git 仓库时属正常）。",
          "可用 /redo 恢复撤回前的内容（需确认）。",
        ].join("\n"),
      );
      load();
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReverting(false);
      setRevertConfirm(undefined);
    }
  };
  const executeUnrevert = async () => {
    setReverting(true);
    try {
      await post(`${threadPath(thread)}/unrevert`, {});
      setStatusNote("已恢复撤回前的内容与文件。");
      load();
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReverting(false);
      setRevertConfirm(undefined);
    }
  };
  /** Timeline 按条“撤回”按钮：opencode 专属，复用同一确认链路。 */
  const openMessageRevert = (turnId: string, item: any) => {
    if (locked || sending || thread.compacting) return;
    const text = displayText(userMessageText(item)).trim().slice(0, 42);
    setRevertConfirm({
      mode: "message",
      messageID: turnId,
      preview: text || "所选消息",
    });
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
      const isOpenCode = (thread.agentId || "codex") === "opencode";
      const created = await post(
        isOpenCode
          ? `${threadPath(thread)}/fork`
          : `/threads/${thread.providerId}/${thread.id}/fork`,
        // OpenCode 原生 fork 用 messageID 做边界，Codex 用 lastTurnId；
        // 通用路由两侧都接受，这里按 Agent 语义发送。
        lastTurnId
          ? isOpenCode
            ? { messageID: lastTurnId }
            : { lastTurnId }
          : {},
      );
      onSelectThread(thread.providerId, created.id);
      onSnapshot();
    } catch (err: any) {
      setError(err.message);
    }
  };
  // events 全扫从每 render 两遍降为一遍；非 running/waiting 直接给空数组，
  // 与旧逻辑一致（旧代码同样按 status 短路）。
  const { streamed, streamedItems } = useMemo(() => {
    if (thread.status !== "running" && thread.status !== "waiting")
      return { streamed: [], streamedItems: [] };
    const live = collectStreamed(
      events,
      thread.providerId,
      thread.id,
      thread.activeTurnId,
      thread.agentId || "codex",
    );
    return { streamed: live.messages, streamedItems: live.items };
  }, [
    events,
    thread.status,
    thread.providerId,
    thread.id,
    thread.activeTurnId,
    thread.agentId,
  ]);
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
  const activeModel = modelCatalog.find(
    (item) => item.model === thread.model || item.id === thread.model,
  );
  const imageWarning =
    (thread.agentId || "codex") === "opencode" &&
    draft.images.length > 0 &&
    activeModel?.supportsImages === false
      ? `${activeModel.displayName} 不支持图片输入，发送会被拒绝；请更换支持视觉的模型或移除图片`
      : "";
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
        onCompact={capabilities.sessionSettings ? compact : undefined}
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
          streamedItems={streamedItems}
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
          onRevertUserMessage={
            (thread.agentId || "codex") === "opencode"
              ? openMessageRevert
              : undefined
          }
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
        imageWarning={imageWarning}
        extraCommands={opencodeCommands}
        branchHint={retrySource?.preview}
        onCancelBranch={
          retrySource ? () => setRetrySource(undefined) : undefined
        }
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
      {revertConfirm && (
        <ConfirmDialog
          title={
            revertConfirm.mode === "redo" ? "恢复已撤回的内容？" : "撤回消息？"
          }
          confirmLabel={
            reverting ? "执行中…" : revertConfirm.mode === "redo" ? "恢复" : "撤回"
          }
          danger={revertConfirm.mode !== "redo"}
          onClose={() => {
            if (!reverting) setRevertConfirm(undefined);
          }}
          onConfirm={() => {
            if (reverting) return;
            if (revertConfirm.mode === "redo") void executeUnrevert();
            else void executeRevert(revertConfirm.messageID);
          }}
          body={
            revertConfirm.mode === "redo" ? (
              <p>
                将恢复撤回前的内容与文件，当前对话中新增的内容可能被覆盖。继续吗？
              </p>
            ) : (
              <div>
                <p>
                  将删除「{revertConfirm.preview}」
                  {revertConfirm.mode === "message"
                    ? "及之后全部回复"
                    : "所在最近一轮及之后全部回复"}
                  ，并恢复相关文件。提交过的重要改动请先自行备份。
                </p>
                <p>若项目不是 git 仓库，仅回滚对话、不恢复文件。</p>
                <p>
                  只想换个说法重试、又不想丢历史时，请取消并改用消息旁的「从此重试」或每轮下的「从此处分支」。
                </p>
              </div>
            )
          }
        />
      )}
    </main>
  );
}
