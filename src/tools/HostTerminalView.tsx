import { useEffect, useState } from "react";
import { FolderOpen, MonitorUp, Terminal } from "lucide-react";
import { post } from "../api";
import type { ToolDescriptor } from "../types";

export function HostTerminalView({
  tool,
  initialCwd,
  directories,
  onToast,
}: {
  tool: ToolDescriptor;
  initialCwd?: string;
  directories: string[];
  onToast: (message: string) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd || directories[0] || "");
  const [launching, setLaunching] = useState(false);
  useEffect(() => {
    if (initialCwd) setCwd(initialCwd);
  }, [initialCwd]);

  const run = async () => {
    if (!cwd.trim() || launching || !tool.available) return;
    setLaunching(true);
    try {
      await post(`/tools/${encodeURIComponent(tool.id)}/run`, {
        cwd: cwd.trim(),
      });
      onToast("已在宿主机打开终端");
    } catch (error: any) {
      onToast(error?.message || "宿主机终端启动失败");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="host-terminal-tool">
      <div className="tool-intro">
        <span>
          <Terminal />
        </span>
        <div>
          <h3>{tool.name}</h3>
          <p>{tool.description}</p>
        </div>
      </div>
      <label className="tool-directory">
        <span>
          <FolderOpen />
          工作目录
        </span>
        <input
          value={cwd}
          list="host-terminal-directories"
          onChange={(event) => setCwd(event.target.value)}
          placeholder="选择或输入绝对路径"
        />
        <datalist id="host-terminal-directories">
          {directories.map((directory) => (
            <option key={directory} value={directory} />
          ))}
        </datalist>
      </label>
      {!tool.available && (
        <p className="tool-unavailable">
          {tool.unavailableReason || "工具不可用"}
        </p>
      )}
      <button
        type="button"
        className="primary tool-launch"
        disabled={!cwd.trim() || launching || !tool.available}
        onClick={() => void run()}
      >
        <MonitorUp />
        {launching ? "正在启动…" : "在宿主机打开"}
      </button>
      <small className="tool-security-note">
        终端窗口只会出现在运行 Codecks Server 的电脑上。
      </small>
    </div>
  );
}
