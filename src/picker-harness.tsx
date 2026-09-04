import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { ModelPicker } from "./ModelPicker";
import { SessionToolbar } from "./layout/SessionToolbar";
import { Modal } from "./ui";
import type { ThreadSummary } from "./types";
import "./styles.css";
import "./project-groups.css";
import "./sidebar.css";
import "./chat.css";
import "./approval-inbox.css";
import "./overlays.css";
import "./tokens.css";
import "./polish.css";
import "./appearance.css";
import "./task-tools.css";
import "./deck-ui.css";
import "./search-picker.css";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = "dark";

const THREAD: ThreadSummary = {
  agentId: "opencode",
  id: "s1",
  providerId: "opencode:/work",
  name: "witty-comet",
  preview: "witty-comet",
  cwd: "/work",
  model: "default",
  status: "idle",
  updatedAt: 1,
};

function Harness() {
  const [thread, setThread] = useState<ThreadSummary>(THREAD);
  return (
    <div className="app-shell">
      <div className="workspace">
        <div className="chat">
          <div className="timeline">
            <p id="state">{JSON.stringify({ model: thread.model, effort: thread.reasoningEffort })}</p>
          </div>
        </div>
      </div>
      <div className="phone-session-settings" style={{ position: "fixed", left: 0, right: 0, bottom: 0 }}>
        <SessionToolbar
          thread={thread}
          variant="panel"
          onSettings={(settings) =>
            setThread((current) => ({ ...current, ...settings }))
          }
          onCompact={() => undefined}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
