import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { api, post, remove } from "../api";
import { dedupeThreadLoad, readThreadCache, writeThreadCache } from "../cache";
import { loadModelCatalog, modelCatalogCache } from "../ModelPicker";
import { SwrCache } from "../swr-cache";
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
  LostWakeWatcher,
  WakeWatcher,
  MessageDelivery,
  MessageDeliveryMode,
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
import { messageControls } from "./message-controls";
import { mergeMessageDeliveries } from "./message-deliveries";
import type { LoadedUserMessage } from "./user-message-reconcile";
import { renderedMessageTurns } from "./timeline-messages";
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
  fetchThreadFull,
  shouldKeepLoadedThread,
  shouldSurfaceThreadLoadError,
} from "./thread-load";
import { draftFromUserMessage, userMessageText } from "./user-message";

const EMPTY_TURNS: any[] = [];

type SessionCommand = { name: string; hint?: string };

/** agent 自报的 `/` 命令列表（opencode、ACP），按会话缓存、落盘。 */
const sessionCommandCache = new SwrCache<SessionCommand[]>({
  persist: "session-commands",
  ttlMs: 5 * 60_000,
  maxEntries: 16,
  maxPersistChars: 50_000,
});

function normalizeSessionCommands(
  list: Array<{ name?: unknown; description?: unknown }>,
): SessionCommand[] {
  return list
    .map((item) => ({
      name: String(item?.name || "").trim(),
      hint: String(item?.description || "").trim() || undefined,
    }))
    .filter((item) => Boolean(item.name));
}

export function ChatWorkspace({
  thread,
  provider,
  agentName,
  capabilities,
  messageDeliveries = [],
  approvals,
  events,
  origin,
  searchTarget,
  wake,
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
  onWake,
}: {
  thread: ThreadSummary;
  provider?: Provider | AgentProfile;
  agentName: string;
  capabilities: AgentCapabilities;
  messageDeliveries?: MessageDelivery[];
  approvals: Approval[];
  events: any[];
  origin?: { name: string; turnLabel?: string; archived?: boolean };
  searchTarget?: {
    turnId?: string;
    itemId?: string;
    query: string;
    request: number;
  };
  /** deck-wake 状态：code=已分配唤醒代号；watcher=本机正在监督的 watcher。 */
  wake?: { code?: string; watcher?: WakeWatcher; lost?: LostWakeWatcher[] };
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
  onWake?: () => void;
}) {
  const threadCacheKey = sessionKey(thread);
  const commandsKey = `${threadPath(thread)}/commands`;
  const [full, setFull] = useState<any>(
    () => readThreadCache(threadCacheKey) || undefined,
  );
  const [draft, setDraft] = useState(() => readComposerDraft(threadCacheKey));
  const [pendingUsers, setPendingUsers] = useState<PendingUserMessage[]>([]);
  const [deliveryReceipts, setDeliveryReceipts] = useState<MessageDelivery[]>([]);
  const observedDeliveryIds = useRef(new Set<string>());
  const deliveryHistoryBefore = useRef(new Map<string, LoadedUserMessage[]>());
  const queuedMessages = useMemo(() => mergeMessageDeliveries(messageDeliveries, deliveryReceipts),
    [messageDeliveries, deliveryReceipts]);
  useEffect(() => {
    for (const item of messageDeliveries) observedDeliveryIds.current.add(item.id);
    setDeliveryReceipts((current) => current.filter((receipt) =>
      !messageDeliveries.some((item) => item.id === receipt.id),
    ));
  }, [messageDeliveries]);
  const [error, setError] = useState("");
  const [threadLoadSettled, setThreadLoadSettled] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [commandModal, setCommandModal] = useState<CommandModalKind>();
  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [sessionCommands, setSessionCommands] = useState<
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
  const loadVersion = useRef(0);
  const updateDraft = (next: typeof draft) => {
    setDraft(writeComposerDraft(threadCacheKey, next));
  };
  const load = useCallback(
    (fresh = false) => {
      const version = loadVersion.current;
      return dedupeThreadLoad(
        threadCacheKey,
        () => fetchThreadFull(thread, threadCacheKey),
        fresh,
      )
        .then((data) => {
          if (version !== loadVersion.current) return;
          const next = (thread.agentId || "codex") === "claude" &&
            shouldKeepLoadedThread(fullRef.current, data)
            ? fullRef.current
            : data;
          setFull(next);
          setPendingUsers((current) =>
            reconcilePendingUserMessages(
              Array.isArray(next?.turns) ? next.turns : [],
              current,
              thread.agentId || "codex",
            ),
          );
          setError("");
        })
        .catch((err) => {
          if (version !== loadVersion.current) return;
          if (shouldSurfaceThreadLoadError(fullRef.current))
            setError(err.message);
        })
        .finally(() => {
          if (version === loadVersion.current) setThreadLoadSettled(true);
        });
    },
    [threadCacheKey, thread.id, thread.providerId, thread.agentId],
  );
  useEffect(() => {
    setThreadLoadSettled(false);
    loadVersion.current += 1;
    const cached = readThreadCache(threadCacheKey);
    fullRef.current = cached || undefined;
    setFull(cached || undefined);
    // 切会话时上一个会话的分支重发意图一并丢弃，避免串到新会话。
    setRetrySource(undefined);
    load();
  }, [load, threadCacheKey]);
  useEffect(() => {
    const id = thread.agentId || "codex";
    // codex 用内置 SLASH_COMMANDS，claude 无会话命令；其余 agent（opencode、
    // ACP）都走 GET /commands 拉取 agent 自报的命令列表，之后由
    // agent.event 的 session/commands 推送增量刷新。
    if (id === "codex" || id === "claude") {
      setSessionCommands([]);
      return;
    }
    let cancelled = false;
    const key = commandsKey;
    // 先用上次的命令列表，`/` 补全打开会话就能用；过期才后台刷新。
    const cached = sessionCommandCache.peek(key);
    setSessionCommands(cached?.value ?? []);
    if (sessionCommandCache.isFresh(cached)) return;
    sessionCommandCache
      .load(key, () =>
        api<{ commands?: Array<{ name: string; description?: string }> }>(
          key,
        ).then((data) =>
          normalizeSessionCommands(
            Array.isArray(data?.commands) ? data.commands : [],
          ),
        ),
      )
      .then((list) => {
        if (!cancelled) setSessionCommands(list);
      })
      .catch(() => {
        if (!cancelled && !cached) setSessionCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [commandsKey, thread.agentId]);
  useEffect(() => {
    const id = thread.agentId || "codex";
    // claude/codex 的模型目录走 ModelPicker 自己的链路；opencode 与 ACP
    // agent 的目录用于 supportsImages 等提示。
    if (id === "codex" || id === "claude" || !thread.providerId) {
      setModelCatalog([]);
      return;
    }
    let cancelled = false;
    // 与 ModelPicker 共用目录缓存：会话设置里的模型选择器也能直接复用。
    const path = `/agents/${encodeURIComponent(id)}/models?providerId=${encodeURIComponent(thread.providerId)}${id === "opencode" && thread.cwd ? `&directory=${encodeURIComponent(thread.cwd)}` : ""}`;
    const cached = modelCatalogCache.peek(path);
    setModelCatalog(cached?.value ?? []);
    if (modelCatalogCache.isFresh(cached)) return;
    loadModelCatalog(path)
      .then((list) => {
        if (!cancelled) setModelCatalog(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [thread.agentId, thread.providerId, thread.cwd]);

  // 只让「非 delta」事件触发 effect：delta 高频且不携带结构变化，若参与
  // 依赖，每次 delta 都会清掉 300ms 历史刷新计时器——持续流式期间
  // full.turns 长期不更新，时间线只能靠 live 事件近似渲染。
  const latestSyncEvent = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const method = String(events[index]?.method || "");
      const event = events[index];
      if (!method || method.toLowerCase().endsWith("/delta")) continue;
      if (event?.providerId && event.providerId !== thread.providerId) continue;
      if ((event?.agentId || "codex") !== (thread.agentId || "codex")) continue;
      if (event?.params?.threadId && event.params.threadId !== thread.id) continue;
      return event;
    }
    return undefined;
  }, [events, thread.providerId, thread.agentId, thread.id]);
  useEffect(() => {
    const event = latestSyncEvent;
    const method = String(event?.method || "");
    if (!method || method.toLowerCase().endsWith("/delta")) return;
    if (event?.providerId && event.providerId !== thread.providerId) return;
    if ((event?.agentId || "codex") !== (thread.agentId || "codex")) return;
    if (event?.params?.threadId && event.params.threadId !== thread.id) return;
    // ACP agent 推送的 availableCommands：实时刷新 `/` 补全。
    if (method === "session/commands") {
      const list = normalizeSessionCommands(
        Array.isArray(event?.params?.commands) ? event.params.commands : [],
      );
      sessionCommandCache.set(commandsKey, list);
      setSessionCommands(list);
      return;
    }
    const immediate = method === "turn/completed" || method === "error";
    if (immediate) {
      load(true);
      return;
    }
    const timer = window.setTimeout(() => load(true), 300);
    return () => window.clearTimeout(timer);
  }, [
    latestSyncEvent,
    load,
    commandsKey,
    thread.id,
    thread.providerId,
    thread.agentId,
  ]);
  const commandPath = (name: string) =>
    `/threads/${thread.providerId}/${thread.id}/${name}`;
  const runCommand = async (command: ComposerCommand) => {
    // ACP agent 没有暴露模型目录时，/model 当作普通斜杠命令原文透传，
    // 由 agent 自己解释（devin acp 尚未把 /model 纳入 advertised commands）。
    if (
      command.kind === "model" &&
      !capabilities.models &&
      thread.agentId !== "codex" &&
      thread.agentId !== "claude" &&
      thread.agentId !== "opencode"
    )
      command = {
        kind: "agent-command",
        command: "model",
        args: command.model || "",
      };
    if (
      thread.agentId === "claude" &&
      !["status", "usage", "ps", "model", "permissions", "skills"].includes(
        command.kind,
      )
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
    // ACP 等通用 agent 的斜杠命令：原样交给 agent 的 runSessionCommand。
    if (command.kind === "agent-command") {
      await post(`${threadPath(thread)}/commands`, {
        command: command.command,
        arguments: command.args,
      });
      onSnapshot();
      return;
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
  const submit = async (candidate: typeof draft, restoreOnFailure: boolean, mode?: MessageDeliveryMode) => {
    const value = candidate.text.trim();
    // State updates are batched; Enter and a button click can reach this handler
    // before `sending` renders. Claim the submission synchronously.
    if (sendingRef.current || reverting || thread.compacting) return;
    const command = parseComposerCommand(value, thread.agentId || "codex");
    const hint = incompleteCommandHint(value);
    if (!command && hint) {
      setError(hint);
      return;
    }
    if (!command && !value && !candidate.images.length) return;
    if (!command && messageControls(thread, capabilities, mode).blocked) {
      setError("会话正在运行，请等待结束或先请求打断");
      return;
    }
    // 分支重发意图下只接受正文发送；斜杠命令走正常链路并丢弃分支意图。
    const branchRetry = !command ? retrySource : undefined;
    if (command && retrySource) setRetrySource(undefined);
    sendingRef.current = true;
    setSending(true);
    setError("");
    setStatusNote("");
    const pendingImages = candidate.images;
    const pendingId = `${threadCacheKey}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const historyBefore = loadedUserMessages(
      renderedMessageTurns(thread, Array.isArray(fullRef.current?.turns) ? fullRef.current.turns : [], streamedItems),
    );
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
        sendingRef.current = false;
        setSending(false);
      }
      return;
    }
    if (!command) {
      const pendingTurnId = mode === "queue" ? undefined : thread.activeTurnId;
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
          historyBefore,
          sentAt: Date.now(),
          deliveryIdsBefore: queuedMessages.map((item) => item.id),
          turnId: pendingTurnId,
          liveItemIds,
        },
      ]);
    }
    try {
      if (command) await runCommand(command);
      else {
        const receipt = await post(
          capabilities.messages ? `${threadPath(thread)}/messages` : threadActionPath(thread, "turns"), {
          text: value,
          ...(mode ? { mode } : {}),
          images: pendingImages.map((image) => ({
            url: image.url,
            name: image.name,
          })),
        });
        if (mode && receipt?.disposition === "queued") {
          deliveryHistoryBefore.current.set(receipt.id, historyBefore);
          setDeliveryReceipts((current) => observedDeliveryIds.current.has(receipt.id) ? current : [...current, {
            ...receipt, text: value, imageCount: pendingImages.length,
          }]);
          setPendingUsers((current) => current.filter((message) => message.id !== pendingId));
        } else if (receipt?.turnId || receipt?.turn?.id) {
          const turnId = receipt.turnId || receipt.turn.id;
          setPendingUsers((current) => current.map((message) => message.id === pendingId
            ? { ...message, turnId, liveItemIds: message.turnId === turnId ? message.liveItemIds : [] }
            : message));
        }
        if (receipt?.disposition === "queued") {
          onToast(mode === "feedback" ? "即时反馈已受理" : "消息已追加，当前任务结束后处理");
          onSnapshot();
        }
      }
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
      sendingRef.current = false;
      setSending(false);
    }
  };
  const send = (mode?: MessageDeliveryMode) => submit(draft, true, mode);
  const readHistoryDraft = (item: any) => {
    const result = draftFromUserMessage(item);
    if (result.skippedImages) onToast("历史图片来自本机路径，请重新选择后发送");
    return result.draft;
  };
  // Codex 走旧 manager 路由；其它 Agent（opencode/claude/acp）走通用
  // Agent API，否则会误进 Codex adapter 报「供应商不存在/源会话不存在」。
  const retryPath = (thread.agentId || "codex") === "codex"
    ? commandPath("retry")
    : `${threadPath(thread)}/retry`;
  /**
   * 从历史消息分支重试（两步式）：先把原文带回输入框并记住来源 turn，
   * 用户改完按发送才真正 fork + 重发；直接发送即用原文重试。
   * 原分支完整保留， destructive 的撤回（undo）只留给真正想抹掉历史时用。
   */
  const retryUserMessage = (turnId: string, item: any) => {
    if (sending || locked || reverting || thread.compacting) return;
    const candidate = readHistoryDraft(item);
    const preview = candidate.text.trim().slice(0, 42) || "所选消息";
    setRetrySource({ turnId, preview });
    updateDraft(candidate);
    setComposerFocusRequest((current) => current + 1);
  };
  const editUserMessage = (turnId: string, item: any) => {
    if (!["codex", "opencode"].includes(thread.agentId || "codex")) return;
    if (sending || locked || reverting || thread.compacting) return;
    const candidate = readHistoryDraft(item);
    void executeRevert(turnId).then((reverted) => {
      if (!reverted) return;
      setRetrySource(undefined);
      updateDraft(candidate);
      setComposerFocusRequest((current) => current + 1);
    });
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
      await post(
        (thread.agentId || "codex") === "codex"
          ? `/threads/${thread.providerId}/${thread.id}/compact`
          : `${threadPath(thread)}/compact`,
      );
      await load(true);
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
      loadVersion.current += 1;
      const turns = fullRef.current?.turns;
      if (Array.isArray(turns)) {
        const cut = turns.findIndex((turn: any) => String(turn?.id) === result.messageID);
        if (cut >= 0) {
          const next = { ...fullRef.current, turns: turns.slice(0, cut) };
          fullRef.current = next;
          setFull(next);
          writeThreadCache(threadCacheKey, next);
        }
      }
      const files = Number(result?.files || 0);
      setStatusNote((thread.agentId || "codex") === "codex"
        ? "已回退到所选消息之前。Codex 仅回退对话历史，工作区文件不会自动恢复。"
        : [
            `已撤回${messageID ? "所选消息及之后" : "最近一轮"}的内容。`,
            files > 0
              ? `恢复 ${files} 个文件（+${result.additions} −${result.deletions}）。`
              : "未发现可恢复的文件快照，仅回滚了对话（非 git 仓库时属正常）。",
            "再次发送前可用 /redo 恢复撤回前的内容（需确认）。",
          ].join("\n"),
      );
      setPendingUsers([]);
      await load(true);
      onSnapshot();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    } finally {
      setReverting(false);
      setRevertConfirm(undefined);
    }
  };
  const executeUnrevert = async () => {
    setReverting(true);
    try {
      await post(`${threadPath(thread)}/unrevert`, {});
      loadVersion.current += 1;
      setStatusNote("已恢复撤回前的内容与文件。");
      await load(true);
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
    sessionMode?: string;
  }) => {
    try {
      await api(threadPath(thread), {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      });
      setError("");
      onSnapshot();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  };
  const forkFrom = async (lastTurnId?: string) => {
    try {
      const agentId = thread.agentId || "codex";
      const created = await post(
        agentId === "codex"
          ? `/threads/${thread.providerId}/${thread.id}/fork`
          : `${threadPath(thread)}/fork`,
        // 所有 Agent 传保留到的轮次；OpenCode adapter 负责换算原生排除边界。
        lastTurnId
          ? { lastTurnId }
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
  const { streamed, streamedItems, streamedEntries } = useMemo(() => {
    if (thread.status !== "running" && thread.status !== "waiting")
      return { streamed: [], streamedItems: [], streamedEntries: [] };
    const live = collectStreamed(
      events,
      thread.providerId,
      thread.id,
      thread.activeTurnId,
      thread.agentId || "codex",
    );
    return {
      streamed: live.messages,
      streamedItems: live.items,
      streamedEntries: live.entries,
    };
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
  // 手动停止留下的 "Aborted" 类文案不算失败，不弹错误横幅。
  const abortedError =
    !taskErrorCode &&
    (/^aborted$/i.test(rawTaskError.trim()) ||
      /MessageAbortedError|AbortedError/i.test(rawTaskError));
  const taskError =
    rawTaskError && !abortedError
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
        wake={wake}
        onBack={onBack}
        onMenu={onMenu}
        onSwitchProvider={onSwitchProvider}
        onAppearance={onAppearance}
        onCompact={capabilities.sessionSettings ? compact : undefined}
        onWake={onWake}
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
          turns={Array.isArray(full?.turns) ? full.turns : EMPTY_TURNS}
          streamed={streamed}
          streamedItems={streamedItems}
          streamedEntries={streamedEntries}
          pendingUsers={pendingUsers}
          messageDeliveries={queuedMessages}
          deliveryHistoryBefore={deliveryHistoryBefore.current}
          onDeliveryCancel={(id) => remove(`${threadPath(thread)}/messages/${encodeURIComponent(id)}`)
            .then(onSnapshot).catch((err: Error) => setError(err.message))}
          onDeliveryRetry={(id) => post(`${threadPath(thread)}/messages/${encodeURIComponent(id)}/retry`)
            .then(onSnapshot).catch((err: Error) => setError(err.message))}
          onDeliveryFeedback={capabilities.messages?.deliveryModes?.includes("feedback")
            ? (id) => post(`${threadPath(thread)}/messages/${encodeURIComponent(id)}/feedback`)
              .then(() => { onToast("已改为即时反馈"); onSnapshot(); })
              .catch((err: Error) => { setError(err.message); onSnapshot(); })
            : undefined}
          feedbackInterrupts={capabilities.messages?.busyBehavior !== "steer"}
          origin={origin}
          onQuickPrompt={(text) => {
            updateDraft({ ...draft, text });
            setComposerFocusRequest((current) => current + 1);
          }}
          targetTurnId={searchTarget?.turnId}
          targetItemId={searchTarget?.itemId}
          targetRequest={searchTarget?.request}
          targetFallbackReady={threadLoadSettled}
          onCopy={() => onToast("已复制")}
          onForkFrom={
            capabilities.fork && ["codex", "claude", "opencode"].includes(thread.agentId || "codex")
              ? (turnId) => forkFrom(turnId)
              : undefined
          }
          onOpenOrigin={onOpenOrigin}
          onEditUserMessage={
            ["codex", "opencode"].includes(thread.agentId || "codex")
              ? editUserMessage
              : undefined
          }
          onRetryUserMessage={
            capabilities.fork && ["codex", "claude"].includes(thread.agentId || "codex")
              ? retryUserMessage
              : undefined
          }
          onRevertUserMessage={
            (thread.agentId || "codex") === "opencode"
              ? openMessageRevert
              : undefined
          }
          messageActionsDisabled={
            locked || sending || reverting || Boolean(thread.compacting)
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
                查看 Codex 额度
              </button>
            )}
          </div>
        </div>
      )}
      {thread.locked && !locked && (
        <div className="lock-banner" role="status">
          <Lock />
          <div>
            <b>会话被其它进程占用</b>
            <p>
              该会话已在另一个进程中打开（{agentName} 的会话锁），此处仅展示缓存
              历史。关闭另一方后可直接发送，Deck 会自动接管。
            </p>
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
        capabilities={capabilities}
        text={draft.text}
        images={draft.images}
        sending={sending || reverting}
        imageWarning={imageWarning}
        extraCommands={[
          // ACP agent 的 /model 走 Deck 模型面板（有目录时），其余命令来自
          // agent 自报的 availableCommands。
          ...(capabilities.models &&
          thread.agentId !== "codex" &&
          thread.agentId !== "claude" &&
          thread.agentId !== "opencode"
            ? [{ name: "/model", hint: "选择模型" }]
            : []),
          ...sessionCommands,
        ]}
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
          void post(
            capabilities.messages ? `${threadPath(thread)}/messages/interrupt` : threadActionPath(thread, "interrupt"),
            capabilities.messages ? { expectedTurnId: thread.activeTurnId } : { turnId: thread.activeTurnId },
          ).then(() => onToast("已请求停止，等待任务结束"))
            .catch((err: Error) => setError(err.message))
        }
        focusRequest={composerFocusRequest}
        sessionControls={
          capabilities.sessionSettings ? (
            <SessionToolbar
              thread={headerThread}
              locked={locked}
              onSettings={saveSettings}
              onCompact={compact}
              showCompact={false}
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
