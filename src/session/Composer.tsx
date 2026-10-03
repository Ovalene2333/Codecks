import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  CircleStop,
  ImagePlus,
  Info,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { AgentCapabilities, ThreadSummary, MessageDeliveryMode } from "../types";
import { messageControls } from "./message-controls";
import { composerEnterAction, useDeckSettings } from "../deck-settings";
import { matchingSlashCommands, opensCommandPanel, parseComposerCommand } from "./commands";
import { collectComposerImages, type ComposerImage } from "./images";

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
  sessionControls,
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
  sessionControls?: ReactNode;
  branchHint?: string;
  onCancelBranch?: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeCmd, setActiveCmd] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const { sendKey } = useDeckSettings();
  const settingsId = useId();
  const helpId = useId();
  const compacting = Boolean(thread.compacting);
  const modes = capabilities?.messages?.deliveryModes;
  const mode = modes?.includes("queue") ? "queue" : modes?.[0];
  const controls = messageControls(thread, capabilities, mode);
  const running = controls.busy;
  const composerAgentId = thread.agentId || "codex";
  const sendBlocked = controls.blocked && !parseComposerCommand(text.trim(), composerAgentId);
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
  useEffect(() => {
    setSettingsOpen(false);
    setHelpOpen(false);
  }, [thread.id, thread.agentId]);
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
      className={`composer ${running ? "running" : ""} ${compacting ? "compacting" : ""} ${dragOver ? "drag-over" : ""}`}
      onKeyDown={(event) => {
        if (helpOpen && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setHelpOpen(false);
          helpTrigger.current?.focus();
        }
      }}
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
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image) => (
            <figure key={image.id}>
              <img src={image.url} alt={image.name} />
              <button
                type="button"
                className="icon-btn"
                title="移除图片"
                onClick={() =>
                  onImages(images.filter((item) => item.id !== image.id))
                }
              >
                <X />
              </button>
            </figure>
          ))}
        </div>
      )}
      {images.length > 0 && imageWarning && (
        <p className="composer-image-warning" role="status">
          {imageWarning}
        </p>
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
      {sessionControls && settingsOpen && (
        <div id={settingsId} className="composer-session-controls">
          {sessionControls}
        </div>
      )}
      <div className="composer-session-summary">
        {sessionControls && !settingsOpen && (
          <span title={thread.resolvedModel || thread.model || "默认模型"}>
            {thread.resolvedModel || thread.model || "默认模型"}
          </span>
        )}
        <div className="composer-summary-actions">
          <button
            ref={helpTrigger}
            type="button"
            className="composer-settings-trigger"
            aria-label="发送说明"
            aria-expanded={helpOpen}
            aria-controls={helpId}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <Info />
            发送说明
          </button>
          {sessionControls && (
            <button
              type="button"
              className="composer-settings-trigger"
              aria-label="会话设置"
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontal />
              设置
              <ChevronDown className={settingsOpen ? "open" : ""} />
            </button>
          )}
        </div>
      </div>
      {helpOpen && (
        <div id={helpId} className="composer-send-help">
          <dl>
            <div><dt>追加</dt><dd>默认等当前任务完成后，再处理这条消息。</dd></div>
            <div><dt>即时反馈</dt><dd>在待发送气泡上点击“即时反馈”，现在介入；必要时会先停止当前任务。</dd></div>
          </dl>
          <p>{controls.help}</p>
        </div>
      )}
      <div className="composer-box">
        <button
          type="button"
          className="icon-btn attach"
          title="添加图片"
          disabled={compacting}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus />
        </button>
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={compacting}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
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
            ) return;
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
              selectSuggestion(item, event.key === "Enter");
              return;
            }
            if (composerEnterAction(event, sendKey) === "send") {
              event.preventDefault();
              if (!compacting && !sendBlocked && canSend && !sending) onSend(mode);
            }
          }}
          placeholder={controls.placeholder}
        />
        <div className="composer-actions">
          {running && thread.activeTurnId && capabilities?.interrupt !== false ? (
            <button
              type="button"
              className="send stop"
              title="停止"
              onClick={onStop}
            >
              <CircleStop />
            </button>
          ) : null}
          <button
            type="button"
            className="send"
            title={controls.label}
            onClick={() => onSend(mode)}
            disabled={compacting || sendBlocked || !canSend || sending}
          >
            <Send />
          </button>
        </div>
      </div>
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
