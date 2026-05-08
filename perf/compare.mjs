#!/usr/bin/env node
// Diff two perf/results/<label>/ folders into a markdown table suitable for
// pasting into a PR description. Use:
//
//   node perf/compare.mjs baseline 01-elapsed-timer
//   node perf/compare.mjs baseline 01-elapsed-timer --output table.md
//
// Each scenario file is JSON; the keys we render are declared in
// SCENARIO_METRICS. Anything not listed there is ignored — keeping the table
// focused on the few headline numbers per scenario rather than dumping every
// captured field.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

const SCENARIO_METRICS = {
  "chat-scroll": [
    { key: "renderReadyMs", label: "Render ready (ms)", lowerIsBetter: true },
    { key: "commitCount", label: "React commits", lowerIsBetter: true },
    { key: "maxActualDurationMs", label: "Worst commit (ms)", lowerIsBetter: true },
    { key: "scrollResponsiveMs", label: "Scroll responsive (ms)", lowerIsBetter: true },
    { key: "scrollDroppedFrames", label: "Dropped frames", lowerIsBetter: true },
    { key: "scrollFps", label: "Scroll FPS", lowerIsBetter: false },
    { key: ["longTasks", "count"], label: "Long tasks", lowerIsBetter: true },
    { key: ["longTasks", "totalMs"], label: "Long task total (ms)", lowerIsBetter: true },
  ],
  "cold-load": [
    { key: "firstContentfulPaintMs", label: "FCP (ms)", lowerIsBetter: true },
    { key: "domInteractiveMs", label: "domInteractive (ms)", lowerIsBetter: true },
    { key: "loadEventMs", label: "loadEvent (ms)", lowerIsBetter: true },
    { key: "jsBytes", label: "JS bytes", lowerIsBetter: true, fmt: "kb" },
    { key: "totalTransferBytes", label: "Total transfer", lowerIsBetter: true, fmt: "kb" },
    { key: ["longTasks", "count"], label: "Long tasks", lowerIsBetter: true },
  ],
  "idle-polling": [
    { key: "apiRequestCount", label: "API requests (idle)", lowerIsBetter: true },
    { key: "apiRequestsPerMinute", label: "Requests/min", lowerIsBetter: true },
    { key: ["longTasksDuringIdle", "count"], label: "Long tasks (idle)", lowerIsBetter: true },
  ],
  "tab-refocus": [
    { key: "apiRequestsAfterRefocus", label: "API requests on refocus", lowerIsBetter: true },
    { key: ["longTasksAfterRefocus", "count"], label: "Long tasks on refocus", lowerIsBetter: true },
  ],
  "ws-burst": [
    { key: "messagesFired", label: "Messages fired", lowerIsBetter: false },
    { key: "timeToIdleAfterBurstMs", label: "Time to idle (ms)", lowerIsBetter: true },
    { key: "droppedFramesAfterBurst", label: "Dropped frames", lowerIsBetter: true },
    { key: ["longTasksAfterBurst", "count"], label: "Long tasks", lowerIsBetter: true },
  ],
  bundle: [
    { key: "totalBytes", label: "Total dist", lowerIsBetter: true, fmt: "kb" },
    { key: "jsBytes", label: "JS bytes", lowerIsBetter: true, fmt: "kb" },
    { key: "jsFileCount", label: "JS chunks", lowerIsBetter: false },
  ],
};

function pluck(obj, key) {
  if (Array.isArray(key)) return key.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return obj?.[key];
}

function fmt(value, kind) {
  if (value == null) return "n/a";
  if (kind === "kb") return `${(value / 1024).toFixed(0)} KB`;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value);
}

function delta(a, b, lowerIsBetter) {
  if (a == null || b == null || typeof a !== "number" || typeof b !== "number") return "—";
  if (a === 0) return b === 0 ? "0%" : "+∞";
  const pct = ((b - a) / a) * 100;
  const sign = pct > 0 ? "+" : "";
  const arrow = (lowerIsBetter ? pct < 0 : pct > 0) ? "✅" : pct === 0 ? "" : "⚠️";
  return `${sign}${pct.toFixed(1)}% ${arrow}`.trim();
}

function loadScenarios(label) {
  const dir = path.join(RESULTS, label);
  if (!fs.existsSync(dir)) {
    console.error(`No results directory at ${dir}. Run scenarios first with PAPERCLIP_PERF_LABEL=${label}.`);
    process.exit(2);
  }
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const content = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    out[content.scenario] = content;
  }
  return out;
}

const [a, b, ...rest] = process.argv.slice(2);
if (!a || !b) {
  console.error("Usage: node perf/compare.mjs <baseline-label> <head-label> [--output file.md]");
  process.exit(1);
}
const outFlagIdx = rest.indexOf("--output");
const outFile = outFlagIdx >= 0 ? rest[outFlagIdx + 1] : null;

const A = loadScenarios(a);
const B = loadScenarios(b);

const lines = [];
lines.push(`# Performance comparison: \`${a}\` → \`${b}\``);
lines.push("");
lines.push(`Generated ${new Date().toISOString()}.`);
lines.push("");

for (const [scenario, metrics] of Object.entries(SCENARIO_METRICS)) {
  if (!A[scenario] && !B[scenario]) continue;
  lines.push(`## ${scenario}`);
  lines.push("");
  lines.push(`| Metric | ${a} | ${b} | Δ |`);
  lines.push("|---|---|---|---|");
  for (const m of metrics) {
    const av = pluck(A[scenario], m.key);
    const bv = pluck(B[scenario], m.key);
    lines.push(`| ${m.label} | ${fmt(av, m.fmt)} | ${fmt(bv, m.fmt)} | ${delta(av, bv, m.lowerIsBetter)} |`);
  }
  lines.push("");
}

const text = lines.join("\n");
if (outFile) {
  fs.writeFileSync(outFile, text);
  console.log(`Wrote ${outFile}`);
} else {
  console.log(text);
}
