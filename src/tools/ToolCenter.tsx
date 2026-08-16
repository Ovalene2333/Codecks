import { useEffect, useState } from "react";
import { Puzzle, Terminal } from "lucide-react";
import { api } from "../api";
import type { ToolDescriptor } from "../types";
import { Drawer } from "../ui";
import { HostTerminalView } from "./HostTerminalView";

const icons = { terminal: Terminal } as const;

export function ToolCenter({
  initialCwd,
  directories,
  onToast,
  onClose,
}: {
  initialCwd?: string;
  directories: string[];
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ tools: ToolDescriptor[] }>("/tools")
      .then((result) => {
        setTools(result.tools);
        setSelected((current) => current || result.tools[0]?.id || "");
      })
      .catch((loadError) => setError(loadError.message));
  }, []);
  const tool = tools.find((item) => item.id === selected);

  return (
    <Drawer title="工具" className="tool-drawer" onClose={onClose}>
      <div className="tool-center">
        <nav className="tool-list" aria-label="可用工具">
          {tools.map((item) => {
            const Icon = icons[item.icon as keyof typeof icons] || Puzzle;
            return (
              <button
                key={item.id}
                type="button"
                className={selected === item.id ? "on" : ""}
                onClick={() => setSelected(item.id)}
              >
                <Icon />
                <span>{item.name}</span>
                <i className={item.available ? "available" : ""} />
              </button>
            );
          })}
        </nav>
        <div className="tool-view">
          {error && <p className="error-banner">{error}</p>}
          {tool?.id === "host-terminal" && (
            <HostTerminalView
              tool={tool}
              initialCwd={initialCwd}
              directories={directories}
              onToast={onToast}
            />
          )}
        </div>
      </div>
    </Drawer>
  );
}
