import { useEffect, useRef, useState } from "react";
import { CircleStop, ImagePlus, Send, X } from "lucide-react";
import type { ThreadSummary } from "../types";
import { matchingSlashCommands } from "./commands";
import {
  collectComposerImages,
  type ComposerImage,
} from "./images";

export function Composer({
  thread,
  text,
  images,
  sending,
  onChange,
  onImages,
  onSend,
  onStop,
  onError,
}: {
  thread: ThreadSummary;
  text: string;
  images: ComposerImage[];
  sending: boolean;
  onChange: (value: string) => void;
  onImages: (images: ComposerImage[]) => void;
  onSend: () => void;
  onStop: () => void;
  onError?: (message: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeCmd, setActiveCmd] = useState(0);
  const compacting = Boolean(thread.compacting);
  const running = thread.status === "running";
  const suggestions = matchingSlashCommands(text);
  const canSend = Boolean(text.trim() || images.length);
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [text]);
  useEffect(() => setActiveCmd(0), [text]);

  const addFiles = async (files: ArrayLike<File>) => {
    try {
      const next = await collectComposerImages(files, images);
      onImages(next.images);
    } catch (error: any) {
      onError?.(error?.message || "无法添加图片");
    }
  };

  return (
    <footer
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
        <div className="slash-menu" role="listbox">
          {suggestions.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className={index === activeCmd ? "on" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(item.name === "!" ? "!" : `${item.name} `);
                area.current?.focus();
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.items || [])
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (!files.length) return;
            event.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(event) => {
            if (suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActiveCmd((current) =>
                event.key === "ArrowDown"
                  ? (current + 1) % suggestions.length
                  : (current - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (suggestions.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
              event.preventDefault();
              const item = suggestions[activeCmd] || suggestions[0];
              onChange(item.name === "!" ? "!" : `${item.name} `);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={
            compacting
              ? "正在压缩上下文"
              : running
                ? "追加到当前任务… 可粘贴图片，输入 / 查看命令"
                : "发送新指令… 可粘贴图片，输入 / 查看命令"
          }
        />
        <div className="composer-actions">
          {running && thread.activeTurnId ? (
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
            title={running ? "追加到当前任务" : "发送新指令"}
            onClick={onSend}
            disabled={compacting || !canSend || sending}
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
