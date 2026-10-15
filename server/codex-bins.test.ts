import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCodexBinCandidates,
  parseCodexVersion,
  resolveEffectiveCodexBin,
} from "./codex-bins.js";

test("parseCodexVersion reads codex-cli versions", () => {
  assert.equal(parseCodexVersion("codex-cli 0.145.0\n"), "0.145.0");
  assert.equal(parseCodexVersion("codex-cli 0.162.1"), "0.162.1");
  assert.equal(parseCodexVersion("something else"), undefined);
});

test("resolveEffectiveCodexBin prefers env, then saved, then PATH default", () => {
  assert.equal(
    resolveEffectiveCodexBin({ CODEX_BIN: "/opt/demo/bin/codex" }, false, "/saved/codex"),
    "/opt/demo/bin/codex",
  );
  assert.equal(resolveEffectiveCodexBin({}, false, ""), "");
});

test("collectCodexBinCandidates honors env override without hardcoding", () => {
  const found = collectCodexBinCandidates(
    { CODEX_BIN: "/opt/demo/bin/codex", PATH: "" },
    false,
  );
  assert.ok(found.some((item) => item.bin === "/opt/demo/bin/codex" && item.source === "env"));
  assert.ok(
    found.every((item) => !item.bin.includes("/data/zhangyice")),
    "must not hardcode machine paths",
  );
});
