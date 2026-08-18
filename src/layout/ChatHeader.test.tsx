import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHeader } from "./ChatHeader";

const thread = {
  agentId: "claude" as const,
  id: "claude-session",
  providerId: "claude-cc-relay",
  name: "Claude session",
  preview: "",
  cwd: "/work/project",
  model: "sonnet",
  status: "idle" as const,
  updatedAt: 1,
};

test("Claude header shows its relay and exposes provider switching", () => {
  const html = renderToStaticMarkup(
    <ChatHeader
      thread={thread}
      provider={{
        id: "claude-cc-relay",
        agentId: "claude",
        name: "Private relay",
        enabled: true,
      }}
      agentName="Claude Code"
      pendingCount={0}
      onBack={() => undefined}
      onMenu={() => undefined}
      onAppearance={() => undefined}
      onSwitchProvider={() => undefined}
    />,
  );

  assert.match(html, /Private relay/);
  assert.match(html, /为此 Session 切换供应商/);
  assert.doesNotMatch(html, />Claude 中转</);
});
