#!/usr/bin/env node
// idle-polling: open the dashboard, sit idle for IDLE_SECONDS (default 60s),
// count network requests. Measures items #3 (visibility-gated polling) and
// #10 (demote polling to WS-disconnect fallback). Pre-fix: dozens of
// requests/min. Post-fix: should approach zero for a logged-in idle user.

import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import { installNetworkCounter, installLongTaskObserver, summarizeLongTasks } from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const SCENARIO = "idle-polling";
const PAGE_URL = baseUrl() + "/";
const ORIGIN = new URL(PAGE_URL).origin;
const IDLE_SECONDS = Number(process.env.PAPERCLIP_PERF_IDLE_SECONDS ?? 60);

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installNetworkCounter);
await context.addInitScript(installLongTaskObserver);

const requests = [];
page.on("request", (req) => {
  const url = req.url();
  // Ignore the page's own document/static asset chatter.
  if (url.startsWith(ORIGIN + "/api/")) requests.push({ url, t: Date.now() });
});

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000); // let initial fetches settle

  const idleStartedAt = Date.now();
  requests.length = 0; // reset so we only count idle-window traffic
  await page.waitForTimeout(IDLE_SECONDS * 1000);
  const idleMs = Date.now() - idleStartedAt;

  const longTasks = await page.evaluate(() => window.__perfLongTasks ?? []);
  const lt = summarizeLongTasks(longTasks);

  // Bucket by URL prefix so we can see which endpoint is the offender.
  const byPath = {};
  for (const r of requests) {
    const path = new URL(r.url).pathname.replace(/\/[a-f0-9-]{8,}/g, "/:id");
    byPath[path] = (byPath[path] ?? 0) + 1;
  }
  const topPaths = Object.entries(byPath)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, n]) => ({ path: p, count: n }));

  const payload = {
    idleSeconds: IDLE_SECONDS,
    actualIdleMs: idleMs,
    apiRequestCount: requests.length,
    apiRequestsPerMinute: Number(((requests.length * 60_000) / idleMs).toFixed(1)),
    topPaths,
    longTasksDuringIdle: lt,
  };

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    "Idle window (s)": IDLE_SECONDS,
    "API requests": requests.length,
    "Requests/minute": payload.apiRequestsPerMinute,
    "Top offender": topPaths[0] ? `${topPaths[0].path} (${topPaths[0].count})` : "none",
    "Long tasks while idle": lt.count,
  });
} finally {
  await browser.close();
}
