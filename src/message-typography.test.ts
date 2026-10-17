import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  MESSAGE_PRESETS,
  messageTypographyVariables,
  normalizeMessageTemplates,
  normalizeMessageTypography,
  sameTypography,
} from "./message-typography";
import { normalizeDeckSettings } from "./deck-settings";
import { AssistantMarkdown } from "./session/markdown";

test("imported typography rejects invalid fields and bounds numeric values", () => {
  const result = normalizeMessageTypography({
    font: "url(evil)",
    fontSize: 500,
    lineHeight: Number.NaN,
    paragraphGap: -5,
    contentWidth: "760",
    codeStyle: "oops",
  });
  assert.equal(result.font, "sans");
  assert.equal(result.fontSize, 22);
  assert.equal(result.lineHeight, 1.55);
  assert.equal(result.paragraphGap, 0);
  assert.equal(result.contentWidth, 0);
  assert.equal(result.codeStyle, "subtle");
  assert.deepEqual(
    normalizeMessageTypography(null),
    DEFAULT_MESSAGE_TYPOGRAPHY,
  );
});

test("templates survive settings export/import while invalid and duplicate ids are dropped", () => {
  const typography = MESSAGE_PRESETS[1].typography;
  const templates = normalizeMessageTemplates([
    null,
    { id: "original", name: "覆盖" },
    { id: "mine", name: " 我的阅读 ", typography },
    { id: "mine", name: "重复" },
    { id: "empty", name: " " },
    { id: "custom", name: "保留值" },
  ]);
  assert.deepEqual(templates, [{ id: "mine", name: "我的阅读", typography }]);
  const settings = normalizeDeckSettings({
    messageTypography: typography,
    messageTemplates: templates,
  });
  assert.deepEqual(
    normalizeDeckSettings(JSON.parse(JSON.stringify(settings))),
    settings,
  );
  assert.ok(sameTypography(settings.messageTypography, typography));
  assert.ok(!sameTypography({ ...typography, fontSize: 18 }, typography));
  assert.equal(
    normalizeMessageTemplates(
      Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, name: "模板" })),
    ).length,
    12,
  );
});

test("message variables restore full width and original styles after switching presets", () => {
  const original = messageTypographyVariables(DEFAULT_MESSAGE_TYPOGRAPHY);
  const comfortable = messageTypographyVariables(MESSAGE_PRESETS[1].typography);
  assert.equal(original["--message-width"], "100%");
  assert.equal(comfortable["--message-width"], "760px");
  assert.equal(comfortable["--message-table-border"], "transparent");
  assert.equal(original["--message-table-border"], "var(--line)");
  assert.deepEqual(Object.keys(original), Object.keys(comfortable));
});

test("assistant markdown preserves headings and contains wide tables", () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMarkdown, {
      text: "# 一级\n\n## 二级\n\n### 三级\n\n| 大小 | 说明 |\n| --- | --- |\n| ~21MB | 缓存 |",
    }),
  );
  assert.match(html, /<h1>一级<\/h1>/);
  assert.match(html, /<h2>二级<\/h2>/);
  assert.match(html, /<h3>三级<\/h3>/);
  assert.match(html, /message-table-scroll/);
  assert.match(html, /class="message-table-number">~21MB/);
});
