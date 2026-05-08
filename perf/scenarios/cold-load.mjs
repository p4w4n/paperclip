#!/usr/bin/env node
// cold-load: open the dashboard root (/) with an empty cache and measure
// time-to-interactive proxies via the Performance API.
//
// Lighthouse CI is the more rigorous tool for this and runs separately. This
// scenario exists as a fast, deterministic check that runs in <30s and can
// be diffed across PRs without spinning up the Lighthouse machinery.
//
// Item #5 (route-level code splitting) and #7 (bundle audit) should reduce
// transferSize and domInteractiveMs here.

import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import { installLongTaskObserver, summarizeLongTasks } from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const SCENARIO = "cold-load";
const PAGE_URL = baseUrl() + "/";
const ORIGIN = new URL(PAGE_URL).origin;

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installLongTaskObserver);

try {
  // Track every resource transfer for a transferSize total.
  const resources = [];
  page.on("response", async (resp) => {
    try {
      const headers = resp.headers();
      const len = Number(headers["content-length"] ?? 0);
      resources.push({
        url: resp.url(),
        status: resp.status(),
        type: headers["content-type"] ?? "",
        size: Number.isFinite(len) ? len : 0,
      });
    } catch {}
  });

  const t0 = Date.now();
  await page.goto(PAGE_URL, { waitUntil: "load" });
  const loadEventMs = Date.now() - t0;

  const nav = await page.evaluate(() => {
    const [n] = performance.getEntriesByType("navigation");
    if (!n) return null;
    return {
      domContentLoadedMs: Number(n.domContentLoadedEventEnd.toFixed(1)),
      domInteractiveMs: Number(n.domInteractive.toFixed(1)),
      loadEventEndMs: Number(n.loadEventEnd.toFixed(1)),
      transferSize: n.transferSize,
      encodedBodySize: n.encodedBodySize,
      decodedBodySize: n.decodedBodySize,
    };
  });

  const paint = await page.evaluate(() => {
    const fcp = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
    return { firstContentfulPaintMs: fcp ? Number(fcp.startTime.toFixed(1)) : null };
  });

  // Wait for app to actually settle (no long task for 500ms) before capturing
  // long-task summary; otherwise we miss late-arriving hydration work.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  const longTasks = await page.evaluate(() => window.__perfLongTasks ?? []);
  const lt = summarizeLongTasks(longTasks);

  const totalTransferBytes = resources.reduce((acc, r) => acc + (r.size || 0), 0);
  const jsResources = resources.filter((r) => r.type.includes("javascript"));
  const jsBytes = jsResources.reduce((acc, r) => acc + (r.size || 0), 0);

  const payload = {
    loadEventMs,
    ...nav,
    ...paint,
    longTasks: lt,
    totalTransferBytes,
    jsBytes,
    jsResourceCount: jsResources.length,
    resourceCount: resources.length,
  };

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    "FCP (ms)": paint.firstContentfulPaintMs ?? "n/a",
    "domInteractive (ms)": nav?.domInteractiveMs ?? "n/a",
    "loadEvent (ms)": loadEventMs,
    "JS bytes": `${(jsBytes / 1024).toFixed(0)} KB across ${jsResources.length} files`,
    "Total transfer": `${(totalTransferBytes / 1024).toFixed(0)} KB`,
    "Long tasks": `${lt.count} (max ${lt.maxMs} ms)`,
  });
} finally {
  await browser.close();
}
