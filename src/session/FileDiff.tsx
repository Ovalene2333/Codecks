import { FilePenLine } from "lucide-react";
import { changeKindLabel, shortenPath } from "../format";
import type { FileChange } from "../types";

function diffLineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@"))
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export function FileDiff({
  changes,
  cwd,
}: {
  changes?: FileChange[] | unknown;
  cwd?: string;
}) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length)
    return <p className="diff-empty">等待文件变更详情…</p>;
  return (
    <div className="file-diff-list">
      {list.map((change, index) => {
        const row =
          change && typeof change === "object"
            ? (change as FileChange)
            : { path: "", kind: undefined, diff: undefined };
        const kind = changeKindLabel(row.kind);
        const diff = typeof row.diff === "string" ? row.diff : "";
        const path = shortenPath(row.path || "", cwd);
        return (
          <details key={`${row.path || "file"}-${index}`} className="file-diff-card">
            <summary>
              <FilePenLine />
              <span className={`kind ${kind}`}>{kind}</span>
              <code className="file-path" title={row.path || path}>
                {path || "未命名文件"}
              </code>
            </summary>
            {diff ? (
              <pre className="file-diff">
                {diff.split("\n").map((line, lineIndex) => (
                  <span key={lineIndex} className={diffLineClass(line)}>
                    {line || " "}
                  </span>
                ))}
              </pre>
            ) : (
              <p className="diff-empty">暂无 diff</p>
            )}
          </details>
        );
      })}
    </div>
  );
}
