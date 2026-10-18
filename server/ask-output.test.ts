import assert from "node:assert/strict";
import test from "node:test";
import { finalAnswer } from "./ask-output.js";

test("unphased native answers preserve all final text blocks and exclude earlier progress", () => {
  assert.equal(finalAnswer({ items: [
    { type: "agentMessage", text: "Checking files" },
    { type: "commandExecution", aggregatedOutput: "Tool output" },
    { type: "reasoning", text: "Private reasoning" },
    { type: "agentMessage", text: "Conclusion" },
    { type: "agentMessage", text: "Validation and artifacts" },
  ] }), "Conclusion\n\nValidation and artifacts");
  assert.equal(finalAnswer({ items: [
    { type: "agentMessage", text: "Checking files" },
    { type: "commandExecution", aggregatedOutput: "Tool output" },
  ] }), "");
});
