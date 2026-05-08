#!/usr/bin/env node
// ws-burst: scaffold scenario for measuring time-to-settle after a burst of
// live events. Monkey-patches `WebSocket` before the app boots so we can
// inject synthetic messages directly into the client without needing a server
// fixture endpoint.
//
// IMPORTANT — this scenario is currently a SCAFFOLD. The synthetic messages
// (`__perfBurstMessages`) below are placeholders that mimic the *envelope*
// shape but are not guaranteed to match every event type the app handles.
// To make it precise:
//   1. Capture a real session's WS messages via DevTools and copy 5–10 typical
//      events into `__perfBurstMessages` below, OR
//   2. Add a server-side endpoint (POST /api/perf/burst) gated on
//      PAPERCLIP_PERF_FIXTURES=true that calls publishLiveEvent N times, and
//      switch this scenario to call that instead of using the WS shim.
//
// With either approach, this scenario measures items #4 (batch WS
// invalidations) and #14 (per-entity reducers instead of broad cache
// invalidation).

import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import {
  installLongTaskObserver,
  installFrameCounter,
  summarizeFrames,
  summarizeLongTasks,
  waitForIdleAfter,
} from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const SCENARIO = "ws-burst";
const PAGE_URL = baseUrl() + "/";
const ORIGIN = new URL(PAGE_URL).origin;
const BURST_COUNT = Number(process.env.PAPERCLIP_PERF_BURST_COUNT ?? 200);

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installLongTaskObserver);
await context.addInitScript(installFrameCounter);

await context.addInitScript(() => {
  // Track every WebSocket the app opens so we can dispatch synthetic messages.
  const OrigWS = window.WebSocket;
  const sockets = [];
  window.WebSocket = class extends OrigWS {
    constructor(url, protocols) {
      super(url, protocols);
      sockets.push(this);
    }
  };
  window.__perfWsSockets = sockets;
  window.__perfBurstMessages = [];
  // Placeholder shapes — replace with captured real-session events. The exact
  // `type` values depend on server/src/services/live-events.ts.
  for (let i = 0; i < 1000; i++) {
    window.__perfBurstMessages.push(
      JSON.stringify({ type: "log_line", runId: `synthetic-${i % 5}`, text: `tick ${i}` }),
      JSON.stringify({ type: "heartbeat_tick", agentId: `synthetic-agent-${i % 10}` }),
    );
  }
  window.__perfFireBurst = (n) => {
    let fired = 0;
    for (const ws of window.__perfWsSockets) {
      for (let i = 0; i < n; i++) {
        const data = window.__perfBurstMessages[i % window.__perfBurstMessages.length];
        ws.dispatchEvent(new MessageEvent("message", { data }));
        fired++;
      }
    }
    return fired;
  };
});

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const burstStartedAt = await page.evaluate(() => performance.now());
  const fired = await page.evaluate((n) => window.__perfFireBurst(n), BURST_COUNT);

  // Wait for the page to "settle" — no long tasks for 250ms — and time it.
  const settleMs = await page.evaluate(waitForIdleAfter("__perfBurstStart__", 250, 15_000).replace("__perfBurstStart__", String(burstStartedAt)));

  const longTasks = await page.evaluate((since) =>
    (window.__perfLongTasks ?? []).filter((t) => t.start >= since), burstStartedAt);
  const lt = summarizeLongTasks(longTasks);

  const frameTimes = await page.evaluate((since) =>
    (window.__perfFrames?.times ?? []).filter((t) => t >= since), burstStartedAt);
  const frames = summarizeFrames(frameTimes);

  const payload = {
    burstCount: BURST_COUNT,
    messagesFired: fired,
    timeToIdleAfterBurstMs: settleMs >= 0 ? Number(settleMs.toFixed(1)) : null,
    longTasksAfterBurst: lt,
    droppedFramesAfterBurst: frames.dropped,
    fpsDuringSettle: frames.fps,
    note: fired === 0 ? "No WebSocket connections were observed — see scenario header for setup notes." : undefined,
  };

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    "Messages fired": fired,
    "Time to idle (ms)": payload.timeToIdleAfterBurstMs ?? "did not settle in 15s",
    "Long tasks during settle": lt.count,
    "Dropped frames": frames.dropped,
  });
} finally {
  await browser.close();
}
