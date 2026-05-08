#!/usr/bin/env node
// Orchestrator: run every scenario in sequence, emit a single summary file
// alongside the per-scenario JSON. Sequential by design — running them in
// parallel introduces measurement crosstalk (CPU contention skews timings).
//
// Set PAPERCLIP_PERF_LABEL to override the output folder name (defaults to
// the current git short SHA).

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveLabel, resolveSha } from "./scenarios/shared/results.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS = [
  { name: "cold-load", file: "scenarios/cold-load.mjs" },
  { name: "chat-scroll", file: "scenarios/chat-scroll.mjs" },
  { name: "idle-polling", file: "scenarios/idle-polling.mjs" },
  { name: "tab-refocus", file: "scenarios/tab-refocus.mjs" },
  { name: "ws-burst", file: "scenarios/ws-burst.mjs" },
  { name: "bundle", file: "bundle/analyze.mjs" },
];

const SKIP = new Set((process.env.PAPERCLIP_PERF_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const failures = [];
for (const s of SCENARIOS) {
  if (SKIP.has(s.name)) {
    console.log(`\n=== skipping ${s.name} ===`);
    continue;
  }
  console.log(`\n=== running ${s.name} ===`);
  const r = spawnSync("node", [s.file], { cwd: HERE, stdio: "inherit" });
  if (r.status !== 0) {
    failures.push({ scenario: s.name, code: r.status });
  }
}

const label = resolveLabel();
const sha = resolveSha();
const summary = {
  label,
  sha,
  finishedAt: new Date().toISOString(),
  scenarios: SCENARIOS.map((s) => s.name).filter((n) => !SKIP.has(n)),
  failures,
};
const outFile = path.join(HERE, "results", label, "summary.json");
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(`\nSummary written to ${path.relative(HERE, outFile)}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} scenario(s) failed:`, failures);
  process.exit(1);
}
