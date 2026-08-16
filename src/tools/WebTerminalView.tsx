import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Keyboard, Power, RefreshCw } from "lucide-react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "../api";
import type { ToolDescriptor } from "../types";

type ConnectionState = "loading" | "connecting" | "connected" | "exited" | "error";

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--terminal-bg", "#101417"),
    foreground: color("--terminal-text", "#d9e0e3"),
    cursor: color("--accent", "#62d6a7"),
    cursorAccent: color("--terminal-bg", "#101417"),
    selectionBackground: color("--terminal-selection", "#31443e"),
    black: "#20272b",
    red: "#f07178",
    green: "#87d96c",
    yellow: "#e6c36a",
    blue: "#6eb4e8",
    magenta: "#c792ea",
    cyan: "#65d1c9",
    white: "#d9e0e3",
    brightBlack: "#6f7c82",
    brightRed: "#ff8b92",
    brightGreen: "#a2e58a",
    brightYellow: "#f2d98b",
    brightBlue: "#8bc8ef",
    brightMagenta: "#d8a6ef",
    brightCyan: "#85e0d9",
    brightWhite: "#f5f7f8",
  };
}

export function WebTerminalView({
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
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  const autoStarted = useRef(false);
  const [cwd, setCwd] = useState(
    initialCwd || directories[0] || tool.defaultCwd || "",
  );
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ConnectionState>("loading");
  const [pid, setPid] = useState<number>();

  useEffect(() => {
    if (!cwd && initialCwd) setCwd(initialCwd);
  }, [cwd, initialCwd]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xterm, fit]) => {
        if (disposed || !mountRef.current) return;
        const terminal = new xterm.Terminal({
          allowProposedApi: false,
          convertEol: true,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily: '"Geist Mono", "Cascadia Mono", Consolas, monospace',
          fontSize: 13,
          lineHeight: 1.3,
          scrollback: 10_000,
          theme: terminalTheme(),
        });
        const fitAddon = new fit.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(mountRef.current);
        terminalRef.current = terminal;
        fitRef.current = fitAddon;
        fitAddon.fit();
        terminal.writeln("\x1b[2m正在连接宿主机终端…\x1b[0m");
        terminal.onData((data) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "input", data }));
        });
        resizeObserver = new ResizeObserver(() => {
          fitAddon.fit();
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: "resize",
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
        });
        resizeObserver.observe(mountRef.current);
        setReady(true);
      })
      .catch((error) => {
        if (disposed) return;
        setState("error");
        onToast(error?.message || "终端组件加载失败");
      });
    return () => {
      disposed = true;
      generationRef.current += 1;
      resizeObserver?.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onToast]);

  const connect = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || !cwd.trim() || !tool.available) return;
    const generation = ++generationRef.current;
    socketRef.current?.close();
    terminal.reset();
    terminal.writeln("\x1b[2m正在连接宿主机终端…\x1b[0m");
    fitRef.current?.fit();
    setState("connecting");
    setPid(undefined);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/ws/tools/${encodeURIComponent(tool.id)}?token=${encodeURIComponent(getToken())}`,
    );
    socketRef.current = socket;
    socket.onopen = () => {
      if (generation !== generationRef.current) return;
      socket.send(
        JSON.stringify({
          type: "start",
          cwd: cwd.trim(),
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    };
    socket.onmessage = ({ data }) => {
      if (generation !== generationRef.current) return;
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        setState("error");
        terminal.writeln("\r\n\x1b[31m终端服务返回了无效消息\x1b[0m");
        return;
      }
      if (message.type === "output") terminal.write(message.data);
      else if (message.type === "ready") {
        setState("connected");
        setPid(message.pid);
        terminal.focus();
      } else if (message.type === "exit") {
        setState("exited");
        setPid(undefined);
        terminal.writeln(
          `\r\n\x1b[2m[进程已退出，代码 ${message.exitCode ?? "-"}]\x1b[0m`,
        );
      } else if (message.type === "error") {
        setState("error");
        terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
        onToast(message.message || "终端连接失败");
      }
    };
    socket.onerror = () => {
      if (generation === generationRef.current) setState("error");
    };
    socket.onclose = () => {
      if (generation !== generationRef.current) return;
      socketRef.current = null;
      setState((current) =>
        current === "exited" || current === "error" ? current : "exited",
      );
    };
  }, [cwd, onToast, tool.available, tool.id]);

  useEffect(() => {
    if (!ready || autoStarted.current || !cwd) return;
    autoStarted.current = true;
    connect();
  }, [connect, cwd, ready]);

  const send = (data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
  };
  const stop = () => {
    generationRef.current += 1;
    socketRef.current?.close();
    socketRef.current = null;
    setState("exited");
    setPid(undefined);
    terminalRef.current?.writeln("\r\n\x1b[2m[连接已关闭]\x1b[0m");
  };
  const connected = state === "connected";

  return (
    <section className="web-terminal-tool" aria-label="Web Terminal">
      <header className="terminal-toolbar">
        <label>
          <FolderOpen />
          <input
            value={cwd}
            list="web-terminal-directories"
            disabled={connected || state === "connecting"}
            onChange={(event) => setCwd(event.target.value)}
            aria-label="终端工作目录"
          />
          <datalist id="web-terminal-directories">
            {directories.map((directory) => (
              <option key={directory} value={directory} />
            ))}
          </datalist>
        </label>
        <span className={`terminal-connection ${connected ? "online" : ""}`}>
          <i />
          {connected
            ? `已连接${pid ? ` · PID ${pid}` : ""}`
            : state === "connecting" || state === "loading"
              ? "连接中"
              : "已断开"}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={connected ? "重新启动终端" : "连接终端"}
          disabled={!ready || !cwd.trim()}
          onClick={connect}
        >
          <RefreshCw />
        </button>
        <button
          type="button"
          className="icon-btn terminal-power"
          title="关闭终端"
          disabled={!connected && state !== "connecting"}
          onClick={stop}
        >
          <Power />
        </button>
      </header>
      <div className="terminal-screen" ref={mountRef} />
      <div className="terminal-mobile-keys" aria-label="终端快捷键">
        <button type="button" onClick={() => send("\u001b")}>Esc</button>
        <button type="button" onClick={() => send("\u0003")}>Ctrl C</button>
        <button type="button" onClick={() => send("\t")}>Tab</button>
        <button type="button" onClick={() => send("\u001b[D")}>←</button>
        <button type="button" onClick={() => send("\u001b[C")}>→</button>
        <button
          type="button"
          title="打开键盘"
          onClick={() => terminalRef.current?.focus()}
        >
          <Keyboard />
        </button>
      </div>
    </section>
  );
}
