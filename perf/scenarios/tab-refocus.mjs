#!/usr/bin/env node
// tab-refocus: open the dashboard, blur the page (simulate switching tabs),
// wait, then refocus and count API requests in the next 5s window.
//
// Pre-fix: refetchOnWindowFocus: true plus broad invalidations cause a
// "request storm" on every refocus. Post-fix (item #2 sets refetchOnWindowFocus
// to false): should be near-zero refocus traffic.

import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import { installLongTaskObserver, summarizeLongTasks } from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const SCENARIO = "tab-refocus";
const PAGE_URL = baseUrl() + "/";
const ORIGIN = new URL(PAGE_URL).origin;
const BLUR_SECONDS = Number(process.env.PAPERCLIP_PERF_BLUR_SECONDS ?? 30);
const REFOCUS_WINDOW_SECONDS = Number(process.env.PAPERCLIP_PERF_REFOCUS_WINDOW_SECONDS ?? 5);

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installLongTaskObserver);

const apiHits = [];
page.on("request", (req) => {
  if (req.url().startsWith(ORIGIN + "/api/")) apiHits.push({ url: req.url(), t: Date.now() });
});

// Programmatic blur/focus via the visibilitychange + focus/blur events,
// because Playwright pages don't lose actual focus when the script runs them.
async function setVisibility(visible) {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
    document.dispatchEvent(new Event("visibilitychange"));
    if (v) {
      window.dispatchEvent(new FocusEvent("focus"));
    } else {
      window.dispatchEvent(new FocusEvent("blur"));
    }
  }, visible);
}

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  await setVisibility(false);
  await page.waitForTimeout(BLUR_SECONDS * 1000);

  apiHits.length = 0;
  const refocusedAt = Date.now();
  await setVisibility(true);
  await page.waitForTimeout(REFOCUS_WINDOW_SECONDS * 1000);

  const longTasks = await page.evaluate(() =>
    (window.__perfLongTasks ?? []).filter((t) => t.start >= performance.now() - 6000),
  );
  const lt = summarizeLongTasks(longTasks);

  const byPath = {};
  for (const r of apiHits) {
    const path = new URL(r.url).pathname.replace(/\/[a-f0-9-]{8,}/g, "/:id");
    byPath[path] = (byPath[path] ?? 0) + 1;
  }
  const topPaths = Object.entries(byPath)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, n]) => ({ path: p, count: n }));

  const payload = {
    blurSeconds: BLUR_SECONDS,
    refocusWindowSeconds: REFOCUS_WINDOW_SECONDS,
    apiRequestsAfterRefocus: apiHits.length,
    topPaths,
    longTasksAfterRefocus: lt,
    refocusedAt,
  };

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    "Blur (s)": BLUR_SECONDS,
    "Refocus window (s)": REFOCUS_WINDOW_SECONDS,
    "API requests on refocus": apiHits.length,
    "Top offender": topPaths[0] ? `${topPaths[0].path} (${topPaths[0].count})` : "none",
    "Long tasks on refocus": lt.count,
  });
} finally {
  await browser.close();
}
