import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initializeAppearance } from "./appearance";
import { initializeDeckSettings } from "./deck-settings";
import { applyPendingLocalCacheClear } from "./cache";
import "./styles.css";
import "./project-groups.css";
import "./sidebar.css";
import "./chat.css";
import "./approval-inbox.css";
import "./overlays.css";
import "./session/operation-status.css";
import "./tokens.css";
import "./task-tools.css";
import "./deck-ui.css";
import "./monitor.css";
import "./search-picker.css";
import "./kit.css";
import "./settings.css";
import "./session-settings.css";
import "./mobile-nav.css";

applyPendingLocalCacheClear();
initializeAppearance();
initializeDeckSettings();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
