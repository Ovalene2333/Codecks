import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Image as ImageIcon, RotateCcw } from "lucide-react";
import { unwrapAssistantMarkup } from "../codexLabels";
import { getBlob } from "../api";

const LOCAL_IMAGE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

export function DeferredImage({
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
}

function CopyablePre({
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

export function AssistantMarkdown({
  text,
  onCopy,
}: {
  text: string;
  onCopy?: () => void;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ src, alt }) => <DeferredImage src={src} alt={alt} />,
          pre: ({ children }) => (
            <CopyablePre onCopy={onCopy}>{children}</CopyablePre>
          ),
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
        }}
      >
        {unwrapAssistantMarkup(text)}
      </ReactMarkdown>
    </div>
  );
}
