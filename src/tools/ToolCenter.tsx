import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import { toolIcon, toolPath, toolView } from "../../plugin/client-registry";
import { deckRewrite, readDeckState } from "../deck-history";
import type { ToolDescriptor } from "../../plugin/types";
import { useDeckSettings } from "../deck-settings";

export function ToolCenter({
  tools: snapshotTools,
  initialCwd,
  directories,
  onToast,
  onClose,
}: {
  /** 快照（含本地缓存）里的工具列表；旧服务端没有时退回 GET /tools。 */
  tools?: ToolDescriptor[];
  initialCwd?: string;
  directories: string[];
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const [fetchedTools, setFetchedTools] = useState<ToolDescriptor[]>();
  const tools = snapshotTools ?? fetchedTools ?? [];
  const [selected, setSelected] = useState(
    () => toolPath(location.pathname)?.slice(1) || "terminal",
  );
  const [error, setError] = useState("");
  const needsFetch = !snapshotTools;
  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    void api<{ tools: ToolDescriptor[] }>("/tools")
      .then((result) => {
        if (!cancelled) setFetchedTools(result.tools);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch]);
  // 浏览器前进/后退在工具页之间跳转时同步当前工具
  useEffect(() => {
    const sync = () => {
      const next = toolPath(location.pathname)?.slice(1);
      if (next) setSelected(next);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const tool = tools.find((item) => item.id === selected);
  // 设置里隐藏的工具不进侧栏；当前打开的那个（直接走链接进来）仍保留。
  const { hiddenTools } = useDeckSettings();
  const listed = tools.filter(
    (item) => item.id === selected || !hiddenTools.includes(item.id),
  );
  const View = tool ? toolView(tool.id) : undefined;

  return (
    <main className="tool-page">
      <header className="tool-page-header">
        <button
          className="icon-btn"
          type="button"
          onClick={onClose}
          title="返回会话"
        >
          <ArrowLeft />
        </button>
        <div>
          <h1>{tool?.name || "工具"}</h1>
          <p>{tool?.description || "正在加载工具…"}</p>
        </div>
      </header>
      <div className="tool-page-body">
        <nav className="tool-list" aria-label="可用工具">
          {listed.map((item) => {
            const Icon = toolIcon(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={selected === item.id ? "on" : ""}
                onClick={() => {
                  setSelected(item.id);
                  if (item.pagePath && location.pathname !== item.pagePath)
                    history.replaceState(
                      deckRewrite(readDeckState(history.state), {
                        page: "tools",
                        view: "workspace",
                      }),
                      "",
                      item.pagePath,
                    );
                }}
              >
                <Icon />
                <span>{item.name}</span>
                <i className={item.available ? "available" : ""} />
              </button>
            );
          })}
        </nav>
        <div className="tool-view">
          {error ? <p className="error-banner">{error}</p> : null}
          {tool && View ? (
            <View
              tool={tool}
              initialCwd={initialCwd || tool.defaultCwd}
              directories={[tool.defaultCwd, ...directories].filter(
                (value, index, values): value is string =>
                  Boolean(value) && values.indexOf(value) === index,
              )}
              onToast={onToast}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}
