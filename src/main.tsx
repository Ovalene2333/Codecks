import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initializeAppearance } from "./appearance";
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

initializeAppearance();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
