// Writes scenario results to perf/results/<sha>/<scenario>.json so compare.mjs
// can diff two folders. Each file contains a single JSON object per the contract
// scenarios document inline at the top of their main script.
//
// Sha resolution order: PAPERCLIP_PERF_SHA env > git rev-parse HEAD > "local".

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

export function resolveSha() {
  if (process.env.PAPERCLIP_PERF_SHA) return process.env.PAPERCLIP_PERF_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "local";
  }
}

export function resolveLabel() {
  return process.env.PAPERCLIP_PERF_LABEL || resolveSha();
}

export function writeResult(scenarioName, payload) {
  const dir = path.join(ROOT, "results", resolveLabel());
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    scenario: scenarioName,
    sha: resolveSha(),
    label: resolveLabel(),
    timestamp: new Date().toISOString(),
    cpuThrottlingRate: Number(process.env.PAPERCLIP_PERF_CPU_THROTTLE ?? 4),
    ...payload,
  };
  const file = path.join(dir, `${scenarioName}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`[perf:${scenarioName}] wrote ${path.relative(ROOT, file)}`);
  return file;
}

export function logSummary(scenarioName, summaryRows) {
  console.log(`\n[perf:${scenarioName}] summary`);
  for (const [k, v] of Object.entries(summaryRows)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}
