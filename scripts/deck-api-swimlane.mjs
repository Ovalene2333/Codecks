#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULTS = {
  input: "shared/deck-api-swimlanes.json",
  output: "docs/deck-api-swimlane.svg",
};

const COLORS = {
  bg: "#161719",
  panel: "#1b1c1f",
  line: "#2e3034",
  text: "#ececee",
  soft: "#c6c8cd",
  dim: "#9b9ea6",
  faint: "#777a83",
  message: "#6b9cf4",
  send: "#a898e6",
  queue: "#d6a343",
  run: "#c6c8cd",
  success: "#4fb286",
  failure: "#e5646e",
  wake: "#57b6c7",
  query: "#9b9ea6",
};

const LANE_COLORS = {
  human: "#d6a343",
  lead: "#6b9cf4",
  service: "#777a83",
  worker: "#a898e6",
  artifact: "#4fb286",
};

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const units = (char) => (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1);

function wrap(text, maxUnits, maxLines = 4) {
  const lines = [];
  let line = "";
  let width = 0;
  for (const char of String(text)) {
    const next = units(char);
    if (width + next > maxUnits && line) {
      lines.push(line);
      if (lines.length >= maxLines) {
        line = "";
        break;
      }
      line = "";
      width = 0;
    }
    line += char;
    width += next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    const joined = lines.join("");
    if (joined.length < String(text).length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
    }
  }
  return lines;
}

function textLines(lines, x, y, lineHeight, attrs = "") {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${y + index * lineHeight}"${attrs}>${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, scenario: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "-i") options.input = argv[++index];
    else if (arg === "--output" || arg === "-o") options.output = argv[++index];
    else if (arg === "--scenario" || arg === "-s") options.scenario = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function scenarioSvg(scenario, top) {
  const laneWidth = 164;
  const stepWidth = 226;
  const rowHeight = 100;
  const axisHeight = 42;
  const headerHeight = 78;
  const pad = 24;
  const width = laneWidth + scenario.steps.length * stepWidth + pad * 2;
  const gridTop = top + headerHeight + axisHeight;
  const gridHeight = scenario.lanes.length * rowHeight;
  const height = headerHeight + axisHeight + gridHeight + 58;
  const laneIndex = new Map(scenario.lanes.map((lane, index) => [lane.id, index]));
  const laneById = new Map(scenario.lanes.map((lane) => [lane.id, lane]));
  const parts = [];

  parts.push(
    `<text x="${pad}" y="${top + 22}" fill="${COLORS.text}" font-size="17" font-weight="600">${escapeXml(scenario.title)}</text>`,
    `<text x="${pad}" y="${top + 42}" fill="${COLORS.faint}" font-size="10">${escapeXml(scenario.kicker)}</text>`,
    `<text x="${pad}" y="${top + 62}" fill="${COLORS.dim}" font-size="11">${textLines(wrap(scenario.summary, 76, 1), pad, top + 62, 14)}</text>`,
  );

  scenario.steps.forEach((step, index) => {
    const x = pad + laneWidth + index * stepWidth;
    parts.push(
      `<line x1="${x}" y1="${gridTop - 12}" x2="${x}" y2="${gridTop + gridHeight}" stroke="${COLORS.line}" stroke-dasharray="3 5" />`,
      `<text x="${x + 8}" y="${gridTop - 20}" fill="${COLORS.dim}" font-family="monospace" font-size="10">${String(index + 1).padStart(2, "0")}</text>`,
      `<text x="${x + 30}" y="${gridTop - 20}" fill="${COLORS.faint}" font-size="9">${escapeXml(step.tag)}</text>`,
    );
  });

  scenario.lanes.forEach((lane, index) => {
    const y = gridTop + index * rowHeight;
    const color = LANE_COLORS[lane.tone] || COLORS.faint;
    parts.push(
      `<rect x="${pad}" y="${y + 6}" width="${laneWidth - 12}" height="${rowHeight - 12}" rx="7" fill="${COLORS.panel}" stroke="${COLORS.line}" />`,
      `<rect x="${pad}" y="${y + 6}" width="3" height="${rowHeight - 12}" rx="1.5" fill="${color}" />`,
      `<text x="${pad + 12}" y="${y + 28}" fill="${COLORS.text}" font-size="12" font-weight="600">${escapeXml(lane.name)}</text>`,
      `<text x="${pad + 12}" y="${y + 48}" fill="${COLORS.faint}" font-size="9">${textLines(wrap(lane.role, 22, 2), pad + 12, y + 48, 12)}</text>`,
    );
  });

  scenario.steps.forEach((step, index) => {
    const from = laneIndex.get(step.from) ?? 0;
    const to = laneIndex.get(step.to) ?? from;
    const x = pad + laneWidth + index * stepWidth + 8;
    const y = gridTop + from * rowHeight + 10;
    const cardWidth = stepWidth - 16;
    const cardHeight = rowHeight - 20;
    const color = COLORS[step.kind] || COLORS.query;
    const title = wrap(step.title, 24, 1);
    const detailY = y + 52;
    const detail = wrap(step.detail, 38, 2);
    const target = laneById.get(step.to)?.name || step.to;
    const route = step.from === step.to ? "本会话内" : `→ ${target}`;
    parts.push(
      `<g>`,
      `<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="7" fill="${COLORS.bg}" stroke="${color}" stroke-opacity="0.55" />`,
      `<circle cx="${x + 15}" cy="${y + 17}" r="4" fill="${color}" />`,
      `<text x="${x + 26}" y="${y + 21}" fill="${color}" font-family="monospace" font-size="9">${escapeXml(step.tag)}</text>`,
      `<text x="${x + 12}" y="${y + 38}" fill="${COLORS.text}" font-size="12" font-weight="600">${textLines(title, x + 12, y + 38, 15)}</text>`,
      `<text x="${x + 12}" y="${detailY}" fill="${COLORS.dim}" font-size="9">${textLines(detail, x + 12, detailY, 11)}</text>`,
      `<text x="${x + 12}" y="${y + cardHeight - 6}" fill="${COLORS.faint}" font-size="9">${escapeXml(route)}</text>`,
      `</g>`,
    );
  });

  return {
    svg: `<g>${parts.join("")}</g>`,
    width,
    height,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/deck-api-swimlane.mjs [--input 数据] [--output svg] [--scenario id]`);
    return;
  }
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const data = JSON.parse(await readFile(inputPath, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.scenarios)) {
    throw new Error("示例数据格式无效：需要 version=1 与 scenarios 数组");
  }
  const scenarios = options.scenario
    ? data.scenarios.filter((item) => item.id === options.scenario)
    : data.scenarios;
  if (!scenarios.length) throw new Error(`找不到场景：${options.scenario}`);

  const rendered = [];
  let top = 30;
  for (const scenario of scenarios) {
    const result = scenarioSvg(scenario, top);
    rendered.push(result.svg);
    top += result.height;
  }
  const width = Math.max(...rendered.map((_, index) => {
    const scenario = scenarios[index];
    return 164 + scenario.steps.length * 226 + 48;
  }));
  const height = top + 18;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(data.title)}">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.bg}" />`,
    `<text x="24" y="20" fill="${COLORS.text}" font-size="13" font-weight="600" font-family="sans-serif">${escapeXml(data.title)}</text>`,
    rendered.join(""),
    `</svg>`,
  ].join("\n");

  await writeFile(outputPath, svg, "utf8");
  console.log(`已生成 ${path.relative(process.cwd(), outputPath)}（${scenarios.length} 个场景）`);
}

main().catch((error) => {
  console.error(`deck-api-swimlane: ${error.message}`);
  process.exitCode = 1;
});
