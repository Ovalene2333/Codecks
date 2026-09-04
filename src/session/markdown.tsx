import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Image as ImageIcon, RotateCcw } from "lucide-react";
import { unwrapAssistantMarkup } from "../codexLabels";
import { getBlob } from "../api";

const LOCAL_IMAGE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

// remarkPlugins / components 内联字面量每次 render 都是新引用，会逼 ReactMarkdown
// 全量重解析。长会话流式场景下同一大 markdown 被反复 parse，提升为模块常量。
const MARKDOWN_PLUGINS = [remarkGfm];

export const DeferredImage = memo(function DeferredImage({
  src,
  alt,
  thread,
}: {
  src?: string;
  alt?: string;
  thread?: { agentId?: string; id: string };
}) {
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState("");
  const url = String(src || "");
  const localPath = LOCAL_IMAGE_PATH.test(url);
  useEffect(() => {
    if (!requested || !localPath || !thread) return;
    let active = true;
    let objectUrl = "";
    void getBlob(
      `/agents/${thread.agentId || "codex"}/threads/${encodeURIComponent(thread.id)}/image?path=${encodeURIComponent(url)}`,
    )
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setLoadedUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setLoadedUrl("");
    };
  }, [localPath, requested, thread?.agentId, thread?.id, url]);
  if (!url) return null;
  if (!requested || failed || (localPath && !loadedUrl))
    return (
      <button
        type="button"
        className="deferred-image"
        onClick={() => {
          setFailed(false);
          setRequested(true);
        }}
        title={failed ? "重新加载图片" : "点击加载图片"}
      >
        {failed ? <RotateCcw aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
        <span>{failed ? "重新加载图片" : requested ? "正在加载图片" : "点击加载图片"}</span>
      </button>
    );
  return (
    <img
      className="markdown-image"
      src={localPath ? loadedUrl : url}
      alt={alt || "生成或引用的图片"}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
});

function CopyablePreInner({
  children,
  onCopy,
}: {
  children?: React.ReactNode;
  onCopy?: () => void;
}) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <button
        type="button"
        className="copy-code"
        onClick={async () => {
          const text = ref.current?.innerText || "";
          await navigator.clipboard.writeText(text);
          onCopy?.();
        }}
      >
        复制
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const CopyablePre = memo(CopyablePreInner);

const MARKDOWN_BASE_COMPONENTS = {
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <DeferredImage src={src} alt={alt} />
  ),
  h1: ({ children }: { children?: React.ReactNode }) => <h3>{children}</h3>,
  h2: ({ children }: { children?: React.ReactNode }) => <h3>{children}</h3>,
};

export const AssistantMarkdown = memo(
  function AssistantMarkdown({
    text,
    onCopy,
  }: {
    text: string;
    onCopy?: () => void;
  }) {
    // pre 需要捕获本实例的 onCopy（复制后 toast），但 a/img/h1/h2 与实例无关，
    // 复用静态引用以减少子树重建。调用方多为内联箭头 onCopy，用 useMemo 固定引用。
    const components = useMemo(
      () => ({
        ...MARKDOWN_BASE_COMPONENTS,
        pre: ({ children }: { children?: React.ReactNode }) => (
          <CopyablePre onCopy={onCopy}>{children}</CopyablePre>
        ),
      }),
      [onCopy],
    );
    return (
      <div className="markdown">
        <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>
          {unwrapAssistantMarkup(text)}
        </ReactMarkdown>
      </div>
    );
  },
  // 调用方常传内联 `onCopy={() => onToast(...)}`，语义恒等。只按 text 比较，
  // 历史 turn 在流式/父级重渲染时可直接命中 memo；流式 active 文本每帧都变，
  // 本来就需要重解析，不影响正确性。
  (prev, next) => prev.text === next.text,
);
