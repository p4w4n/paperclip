#!/usr/bin/env node
// Build the UI in production mode and emit a chunk-size summary as JSON.
// Pairs with rollup-plugin-visualizer for the human-readable HTML output, but
// the JSON is what compare.mjs diffs across two runs.
//
// We do NOT modify ui/vite.config.ts to add the visualizer permanently; instead
// we set VITE_PERF_BUNDLE=1 and the harness expects a follow-up PR to wire the
// plugin conditionally. Until that PR lands, this script emits chunk sizes
// from the built dist/ directly using fs.statSync — which is sufficient for
// before/after comparison even without the visualizer HTML.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeResult, logSummary } from "../scenarios/shared/results.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const UI_DIR = path.join(REPO, "ui");
const DIST = path.join(UI_DIR, "dist");

console.log("[perf:bundle] building UI in production mode...");
execSync("pnpm --filter @paperclipai/ui build", { cwd: REPO, stdio: "inherit", env: { ...process.env, VITE_PERF_BUNDLE: "1" } });

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push({ path: path.relative(DIST, full), size: stat.size });
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.error(`[perf:bundle] dist/ not found at ${DIST}`);
  process.exit(1);
}

const files = walk(DIST);
const js = files.filter((f) => f.path.endsWith(".js"));
const css = files.filter((f) => f.path.endsWith(".css"));
const other = files.filter((f) => !f.path.endsWith(".js") && !f.path.endsWith(".css"));

const sumSize = (xs) => xs.reduce((a, b) => a + b.size, 0);
const top = (xs, n) =>
  [...xs]
    .sort((a, b) => b.size - a.size)
    .slice(0, n)
    .map((f) => ({ path: f.path, size: f.size }));

const payload = {
  totalBytes: sumSize(files),
  jsBytes: sumSize(js),
  cssBytes: sumSize(css),
  otherBytes: sumSize(other),
  jsFileCount: js.length,
  cssFileCount: css.length,
  topJsChunks: top(js, 15),
  topAssets: top(other, 10),
};

writeResult("bundle", payload);
logSummary("bundle", {
  "Total dist bytes": `${(payload.totalBytes / 1024).toFixed(0)} KB`,
  "JS bytes": `${(payload.jsBytes / 1024).toFixed(0)} KB across ${payload.jsFileCount} files`,
  "CSS bytes": `${(payload.cssBytes / 1024).toFixed(0)} KB`,
  "Largest JS chunk": payload.topJsChunks[0]
    ? `${payload.topJsChunks[0].path} (${(payload.topJsChunks[0].size / 1024).toFixed(0)} KB)`
    : "n/a",
});
