import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Square, SlidersHorizontal, X } from "lucide-react";
import type {
  AgentCapabilities,
  ApprovalMode,
  ClaudePermissionMode,
  SandboxMode,
  ThreadSummary,
  MessageDeliveryMode,
} from "../types";
import { messageControls } from "./message-controls";
import { composerEnterAction, useDeckSettings } from "../deck-settings";
import {
  APPROVAL_OPTIONS,
  FALLBACK_EFFORTS,
  SANDBOX_OPTIONS,
  approvalMode,
  approvalModeLabel,
  contextShortLabel,
  reasoningEffortLabel,
  sandboxLabel,
} from "../codexLabels";
import { CLAUDE_PERMISSION_OPTIONS } from "../layout/SessionToolbar";
import { loadModelCatalog, modelCatalogCache } from "../ModelPicker";
import {
  matchingSlashCommands,
  opensCommandPanel,
  parseComposerCommand,
} from "./commands";
import { collectComposerImages, type ComposerImage } from "./images";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
  PromptInputTools,
} from "./PromptInput";

export type ComposerContextPatch = {
  reasoningEffort?: string;
  sandbox?: SandboxMode;
  approvalMode?: ApprovalMode;
  permissionMode?: ClaudePermissionMode;
};

type ContextField = "effort" | "sandbox" | "approval" | "permission";

/** Composer 的模型目录请求键（与 ModelPicker 的拆分逻辑一致）。 */
function catalogPathForComposer(thread: {
  agentId?: string;
  providerId: string;
  cwd?: string;
}) {
  const agentId = thread.agentId || "codex";
  return agentId === "opencode"
    ? `/agents/opencode/models${thread.cwd ? `?directory=${encodeURIComponent(thread.cwd)}` : ""}`
    : agentId !== "codex"
      ? `/agents/${agentId}/models?providerId=${encodeURIComponent(thread.providerId || "")}`
      : `/providers/${thread.providerId}/models`;
}

function composerCatalogEnabled(thread: {
  agentId?: string;
  providerId: string;
}) {
  const agentId = thread.agentId || "codex";
  return agentId === "codex"
    ? Boolean(thread.providerId)
    : agentId === "opencode" || Boolean(thread.providerId);
}

const CONTEXT_FIELD_LABELS: Record<ContextField, string> = {
  effort: "推理强度",
  sandbox: "沙箱",
  approval: "审批",
  permission: "权限",
};

export function Composer({
  thread,
  capabilities,
  text,
  images,
  sending,
  imageWarning,
  onChange,
  onImages,
  onSend,
  onCommand,
  onStop,
  onError,
  focusRequest = 0,
  onSessionSettings,
  onQuickSetting,
  extraCommands = [],
  branchHint,
  onCancelBranch,
}: {
  thread: ThreadSummary;
  capabilities?: AgentCapabilities;
  text: string;
  images: ComposerImage[];
  sending: boolean;
  imageWarning?: string;
  extraCommands?: Array<{ name: string; hint?: string }>;
  onChange: (value: string) => void;
  onImages: (images: ComposerImage[]) => void;
  onSend: (mode?: MessageDeliveryMode) => void;
  onCommand: (command: string) => void;
  onStop: () => void;
  onError?: (message: string) => void;
  focusRequest?: number;
  onSessionSettings?: () => void;
  onQuickSetting?: (patch: ComposerContextPatch) => unknown;
  branchHint?: string;
  onCancelBranch?: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const composerRoot = useRef<HTMLElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeCmd, setActiveCmd] = useState(0);
  const [contextMenu, setContextMenu] = useState<{
    field: ContextField;
    left: number;
    bottom: number;
  } | null>(null);
  const { sendKey } = useDeckSettings();
  const compacting = Boolean(thread.compacting);
  const modes = capabilities?.messages?.deliveryModes;
  const mode = modes?.includes("queue") ? "queue" : modes?.[0];
  const controls = messageControls(thread, capabilities, mode);
  const running = controls.busy;
  const composerAgentId = thread.agentId || "codex";
  // 输入框底部中间的当前配置：四个固定槽位（模型/推理强度/沙箱/审批），
  // 渲染成 kit ui-badge 同款语言的 chip，只显示当前值，空槽隐藏占位，
  // 仅桌面端显示。
  const contextModelRaw = thread.resolvedModel || thread.model || "默认";
  // 展示名优先级：服务端 modelLabel > 本地目录缓存 > 压缩 ID。
  // 缓存在 useState 里同步种下，命中过的供应商首帧就是展示名。
  const [modelNames, setModelNames] = useState<Record<string, string>>({
    ...(() => {
      const entry = modelCatalogCache.peek(catalogPathForComposer(thread))?.value;
      const names: Record<string, string> = {};
      if (entry)
        for (const item of entry)
          names[item.model] = item.displayName || item.model;
      return names;
    })(),
  });
  useEffect(() => {
    if (!composerCatalogEnabled(thread)) return;
    const path = catalogPathForComposer(thread);
    let cancelled = false;
    loadModelCatalog(path)
      .then((list) => {
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const item of list)
          names[item.model] = item.displayName || item.model;
        setModelNames(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [composerAgentId, thread.providerId, thread.cwd]);
  const contextModelShort =
    contextModelRaw.split("/").filter(Boolean).pop() || contextModelRaw;
  const contextModel =
    (thread.modelLabel && thread.modelLabel !== contextModelRaw
      ? thread.modelLabel
      : undefined) ||
    modelNames[contextModelRaw] ||
    modelNames[contextModelShort] ||
    contextModelShort;
  const contextEffort = thread.reasoningEffort
    ? reasoningEffortLabel(thread.reasoningEffort)
    : "";
  const contextSandbox =
    composerAgentId === "codex"
      ? sandboxLabel(thread.sandbox || "workspace-write")
      : "";
  const contextPermission =
    composerAgentId === "claude"
      ? CLAUDE_PERMISSION_OPTIONS.find(
          (option) => option.value === (thread.permissionMode || "default"),
        )?.label || ""
      : composerAgentId === "codex"
        ? approvalModeLabel(thread.approvalPolicy, thread.approvalsReviewer)
        : "";
  const contextSlots: Array<{ name: string; value: string; full?: string }> = [
    { name: "模型", value: contextModel, full: contextModelRaw },
    { name: "推理强度", value: contextEffort },
    { name: "沙箱", value: contextSandbox },
    {
      name: composerAgentId === "claude" ? "权限" : "审批",
      value: contextPermission,
    },
  ];
  const contextAria = contextSlots
    .filter((slot) => slot.value)
    .map((slot) => `${slot.name}${slot.full ?? slot.value}`)
    .join("，");
  // 格子带显示用两字压缩值；aria/title 保持全名。
  const contextDisplaySlots = contextSlots.map((slot) => ({
    ...slot,
    short: slot.name === "模型" ? slot.value : contextShortLabel(slot.value),
  }));
  const contextSegClass = (slot: { name: string; value: string }) =>
    `composer-context-seg${slot.name === "模型" ? " is-model" : ""}${slot.value ? "" : " is-empty"}`;
  // 段快捷菜单：点值直接弹该槽位候选，少一次进设置面板；模型段仍走面板。
  const effortChoices = [
    { value: "", label: "默认" },
    ...FALLBACK_EFFORTS.filter(
      (item) => composerAgentId !== "claude" || item !== "minimal",
    ).map((item) => ({ value: item, label: reasoningEffortLabel(item) })),
  ];
  const CONTEXT_CURRENT: Record<ContextField, string> = {
    effort: thread.reasoningEffort || "",
    sandbox: thread.sandbox || "workspace-write",
    approval: approvalMode(thread.approvalPolicy, thread.approvalsReviewer),
    permission: thread.permissionMode || "default",
  };
  const contextChoicesFor = (field: ContextField) => {
    switch (field) {
      case "effort":
        return effortChoices;
      case "sandbox":
        return SANDBOX_OPTIONS.map((item) => ({
          value: item.value as string,
          label: item.label,
        }));
      case "approval":
        return APPROVAL_OPTIONS.map((item) => ({
          value: item.value as string,
          label: item.label,
        }));
      case "permission":
        return CLAUDE_PERMISSION_OPTIONS.map((item) => ({
          value: item.value as string,
          label: item.label,
        }));
    }
  };
  const openContextSegment = (
    field: ContextField | null,
    node: HTMLElement,
  ) => {
    if (!onQuickSetting || !field) {
      onSessionSettings?.();
      return;
    }
    const root = composerRoot.current?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!root) {
      setContextMenu({ field, left: rect.left + rect.width / 2, bottom: rect.bottom + 8 });
      return;
    }
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - root.left, 72),
      Math.max(root.width - 72, 72),
    );
    setContextMenu((current) =>
      current?.field === field
        ? null
        : {
            field,
            left,
            bottom: root.bottom - rect.top + 8,
          },
    );
  };
  const chooseContextValue = (value: string) => {
    if (!contextMenu || !onQuickSetting) return;
    const { field } = contextMenu;
    setContextMenu(null);
    if (field === "effort") onQuickSetting({ reasoningEffort: value });
    else if (field === "sandbox")
      onQuickSetting({ sandbox: value as SandboxMode });
    else if (field === "approval")
      onQuickSetting({ approvalMode: value as ApprovalMode });
    else onQuickSetting({ permissionMode: value as ClaudePermissionMode });
  };
  const sendBlocked =
    controls.blocked && !parseComposerCommand(text.trim(), composerAgentId);
  const suggestions = matchingSlashCommands(
    text,
    composerAgentId,
    composerAgentId === "codex" || composerAgentId === "claude"
      ? []
      : extraCommands,
  );
  const canSend = Boolean(text.trim() || images.length);
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = text ? `${Math.min(node.scrollHeight, 160)}px` : "";
  }, [text]);
  useEffect(() => setActiveCmd(0), [text]);
  // 菜单限高后可滚动：键盘上下移动时让高亮项保持可见。
  useLayoutEffect(() => {
    const container = menu.current;
    const active = container?.querySelector<HTMLElement>("button.on");
    if (!container || !active) return;
    const top =
      active.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    if (top < container.scrollTop) {
      container.scrollTop = top;
    } else if (
      top + active.offsetHeight >
      container.scrollTop + container.clientHeight
    ) {
      container.scrollTop = top + active.offsetHeight - container.clientHeight;
    }
  }, [activeCmd, suggestions.length]);
  useEffect(() => {
    if (!focusRequest) return;
    const node = area.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [focusRequest]);

  const addFiles = async (files: ArrayLike<File>) => {
    try {
      const next = await collectComposerImages(files, images);
      onImages(next.images);
    } catch (error: any) {
      onError?.(error?.message || "无法添加图片");
    }
  };

  const selectSuggestion = (
    item: (typeof suggestions)[number],
    executePanelCommand: boolean,
  ) => {
    if (executePanelCommand && opensCommandPanel(item.name)) {
      onCommand(item.name);
      return;
    }
    onChange(item.name === "!" ? "!" : `${item.name} `);
    area.current?.focus();
  };

  return (
    <footer
      ref={composerRoot}
      className={`composer ${running ? "running" : ""} ${compacting ? "compacting" : ""} ${dragOver ? "drag-over" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer?.types.includes("Files")) setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 && (
        <div className="slash-menu" role="listbox" ref={menu}>
          {suggestions.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className={index === activeCmd ? "on" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                selectSuggestion(item, true);
              }}
            >
              <code>{item.name}</code>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      {branchHint && (
        <div className="composer-branch-hint" role="status">
          <span>
            将从「{branchHint}」分支重发，原分支保留；直接发送即用当前文字重试
          </span>
          {onCancelBranch && (
            <button
              type="button"
              className="icon-btn"
              title="取消分支重发，改为普通发送"
              onClick={onCancelBranch}
            >
              <X />
            </button>
          )}
        </div>
      )}
      {/* 移动端格子带中部：effort/沙箱/审批 的当前值，居中一段，
          点按打开会话设置；桌面端有完整格子带，这里恒隐藏。 */}
      <PromptInput className="composer-box">
        {images.length > 0 && (
          <PromptInputHeader>
            <div className="composer-images">
              {images.map((image) => (
                <figure key={image.id}>
                  <img src={image.url} alt={image.name} />
                  <button
                    type="button"
                    className="icon-btn"
                    title="移除图片"
                    aria-label={`移除图片 ${image.name}`}
                    onClick={() =>
                      onImages(images.filter((item) => item.id !== image.id))
                    }
                  >
                    <X />
                  </button>
                </figure>
              ))}
            </div>
            {imageWarning && (
              <p className="composer-image-warning" role="status">
                {imageWarning}
              </p>
            )}
          </PromptInputHeader>
        )}
        {/* 输入行右侧的 ghost 模型 ID：只在空输入、无图片头时出现，
            跟 placeholder 同行右对齐；点按输入区落在 textarea 上。 */}
        <div className="composer-input-root">
          {!compacting && !text && !images.length && (
            <div className="composer-model-ghost" aria-hidden="true">
              {contextModel}
            </div>
          )}
          <PromptInputTextarea
            ref={area}
            rows={1}
            value={text}
            aria-label="消息"
            disabled={compacting}
            onChange={(event) => onChange(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.items || [])
                .filter(
                  (item) =>
                    item.kind === "file" && item.type.startsWith("image/"),
                )
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (!files.length) return;
              event.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(event) => {
              // Enter confirms an IME candidate before the final onChange. Sending
              // here would submit the old draft and then put that text back.
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              if (
                suggestions.length &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                setActiveCmd((current) =>
                  event.key === "ArrowDown"
                    ? (current + 1) % suggestions.length
                    : (current - 1 + suggestions.length) % suggestions.length,
                );
                return;
              }
              if (
                suggestions.length &&
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey))
              ) {
                event.preventDefault();
                const item = suggestions[activeCmd] || suggestions[0];
                selectSuggestion(item, true);
                return;
              }
              if (composerEnterAction(event, sendKey) === "send") {
                event.preventDefault();
                if (!compacting && !sendBlocked && canSend && !sending)
                  onSend(mode);
              }
            }}
            placeholder={controls.placeholder}
          />
        </div>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton
              className="attach icon-only"
              title="添加图片"
              aria-label="添加图片"
              disabled={compacting}
              onClick={() => picker.current?.click()}
            >
              <ImagePlus />
            </PromptInputButton>
            {onSessionSettings && (
              <PromptInputButton
                className="composer-settings-trigger icon-only"
                title="会话设置"
                aria-label="会话设置"
                onClick={onSessionSettings}
              >
                <SlidersHorizontal />
              </PromptInputButton>
            )}
            {/* 当前配置一条分段式状态条：与输入框本体同一容器语言，
                显示两字压缩值，空槽留白占位；可点时每段都打开会话设置。 */}
            {onSessionSettings ? (
              <div
                className="composer-context"
                aria-label={`当前配置：${contextAria}`}
              >
                {contextDisplaySlots.map((slot) => (
                  <button
                    key={slot.name}
                    type="button"
                    className={contextSegClass(slot)}
                    title={`${slot.name}：${slot.full ?? slot.value}`}
                    aria-label={`${slot.name}：${slot.full ?? slot.value}`}
                    onClick={(event) =>
                      openContextSegment(
                        slot.name === "推理强度"
                          ? "effort"
                          : slot.name === "沙箱" && composerAgentId === "codex"
                            ? "sandbox"
                            : slot.name === "审批" && composerAgentId === "codex"
                              ? "approval"
                              : slot.name === "权限" && composerAgentId === "claude"
                                ? "permission"
                                : null,
                        event.currentTarget,
                      )
                    }
                  >
                    <span className="composer-context-seg__value">
                      {slot.short}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div
                className="composer-context"
                aria-label={`当前配置：${contextAria}`}
              >
                {contextDisplaySlots.map((slot) => (
                  <span
                    key={slot.name}
                    className={contextSegClass(slot)}
                    title={slot.value ? `${slot.name}：${slot.value}` : undefined}
                  >
                    <span className="composer-context-seg__value">
                      {slot.short}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </PromptInputTools>
          <div className="composer-actions">
            {/* 停止键常驻占位：非运行时只隐藏不抽掉，右侧宽度恒定，
                中部状态条不因回合开始/结束而左右跳动。 */}
            {capabilities?.interrupt !== false ? (
              <PromptInputButton
                className={`send stop${running ? "" : " is-phantom"}`}
                title="停止"
                aria-label="停止"
                onClick={onStop}
              >
                <Square />
              </PromptInputButton>
            ) : null}
            <PromptInputButton
              className="send"
              title={controls.label}
              aria-label={controls.label}
              onClick={() => onSend(mode)}
              disabled={compacting || sendBlocked || !canSend || sending}
            >
              <ArrowUp />
            </PromptInputButton>
          </div>
        </PromptInputFooter>
      </PromptInput>
      {contextMenu && (
        <>
          <div
            className="composer-context-backdrop"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="composer-context-menu"
            role="listbox"
            aria-label={`选择${CONTEXT_FIELD_LABELS[contextMenu.field]}`}
            style={{ left: contextMenu.left, bottom: contextMenu.bottom }}
          >
            {(contextChoicesFor(contextMenu.field) || []).map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={CONTEXT_CURRENT[contextMenu.field] === choice.value ? "on" : ""}
                title={choice.label}
                onClick={() => chooseContextValue(choice.value)}
              >
                {choice.label}
              </button>
            ))}
            {onSessionSettings && (
              <button
                type="button"
                className="more"
                onClick={() => {
                  setContextMenu(null);
                  onSessionSettings();
                }}
              >
                更多设置…
              </button>
            )}
          </div>
        </>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </footer>
  );
}
