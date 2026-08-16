import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Status } from "./ui.js";

test("running status shows the running label", () => {
  const html = renderToStaticMarkup(
    createElement(Status, { status: "running", compact: true }),
  );
  assert.match(html, /运行中/);
});
