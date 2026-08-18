import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
  configurable: true,
});

const { ProviderSwitchModal } = await import("./ProviderSwitchModal");

test("Claude provider switch only offers supported relay profiles", () => {
  const html = renderToStaticMarkup(
    <ProviderSwitchModal
      thread={{
        agentId: "claude",
        id: "claude-session",
        providerId: "claude-cc-current",
        name: "Claude session",
        preview: "",
        cwd: "/work",
        model: "sonnet",
        status: "idle",
        updatedAt: 1,
      }}
      providers={[]}
      agentProfiles={[
        {
          id: "claude-cc-current",
          agentId: "claude",
          name: "Current relay",
          enabled: true,
        },
        {
          id: "claude-cc-backup",
          agentId: "claude",
          name: "Backup relay",
          enabled: true,
        },
        {
          id: "claude-cc-official",
          agentId: "claude",
          name: "Claude Official",
          official: true,
          enabled: false,
        },
      ]}
      onClose={() => undefined}
      onCreated={() => undefined}
    />,
  );

  assert.match(html, /从下一轮开始使用新中转/);
  assert.match(html, /Backup relay/);
  assert.doesNotMatch(html, /Claude Official/);
  assert.doesNotMatch(html, /Current relay/);
});
