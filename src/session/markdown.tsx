import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unwrapAssistantMarkup } from "../codexLabels";

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
          img: () => null,
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
