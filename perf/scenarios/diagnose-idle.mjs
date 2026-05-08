#!/usr/bin/env node
// Diagnostic-only: captures every long task with full timing + a periodicity
// histogram, plus all WebSocket frames, plus all setInterval/setTimeout calls
// that fire during a 60s idle window. Use when idle-polling.json shows an
// unexpected long-task count on an empty company (391 was the trigger here).
//
// Output is intentionally verbose — meant for one-off investigation, not
// regression tracking. Writes to perf/results/<label>/diagnose-idle.json.

import { launch, newPerfPage, baseUrl } from "./shared/browser.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const PAGE_URL = baseUrl() + "/";
const IDLE_SECONDS = 60;

const browser = await launch();
const { context, page } = await newPerfPage(browser);

await context.addInitScript(() => {
  // Long tasks
  window.__diagLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__diagLongTasks.push({ start: e.startTime, duration: e.duration, name: e.name });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  // setInterval/setTimeout instrumentation
  window.__diagTimers = { intervals: [], timeouts: [], rafCount: 0 };
  const origInterval = window.setInterval.bind(window);
  window.setInterval = function(fn, ms, ...args) {
    const id = origInterval(fn, ms, ...args);
    const stack = new Error().stack?.split("\n").slice(2, 6).join(" | ") ?? "";
    window.__diagTimers.intervals.push({ id, ms, stack: stack.slice(0, 400), createdAt: performance.now() });
    return id;
  };
  const origTimeout = window.setTimeout.bind(window);
  window.setTimeout = function(fn, ms, ...args) {
    const id = origTimeout(fn, ms, ...args);
    if (ms !== undefined && ms < 5000) {
      // Only log short-ish timeouts; long ones are usually one-shots
      const stack = new Error().stack?.split("\n").slice(2, 5).join(" | ") ?? "";
      window.__diagTimers.timeouts.push({ id, ms, stack: stack.slice(0, 300), createdAt: performance.now() });
    }
    return id;
  };
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    window.__diagTimers.rafCount++;
    return origRaf(cb);
  };

  // WebSocket frame counter
  window.__diagWsFrames = { sent: 0, received: 0, sentSamples: [], receivedSamples: [] };
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(url, protocols) {
      super(url, protocols);
      const proxy = this;
      this.addEventListener("message", (e) => {
        window.__diagWsFrames.received++;
        if (window.__diagWsFrames.receivedSamples.length < 50) {
          const data = typeof e.data === "string" ? e.data.slice(0, 200) : "[binary]";
          window.__diagWsFrames.receivedSamples.push({ t: performance.now(), data });
        }
      });
      const origSend = this.send.bind(this);
      this.send = function(data) {
        window.__diagWsFrames.sent++;
        if (window.__diagWsFrames.sentSamples.length < 50) {
          const sample = typeof data === "string" ? data.slice(0, 200) : "[binary]";
          window.__diagWsFrames.sentSamples.push({ t: performance.now(), data: sample });
        }
        return origSend(data);
      };
    }
  };
});

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const idleStart = await page.evaluate(() => performance.now());
  // Reset counters so we only measure idle window
  await page.evaluate(() => {
    window.__diagLongTasks = [];
    window.__diagTimers.rafCount = 0;
    window.__diagWsFrames.sent = 0;
    window.__diagWsFrames.received = 0;
    window.__diagWsFrames.sentSamples = [];
    window.__diagWsFrames.receivedSamples = [];
  });

  console.log(`[diagnose-idle] sitting idle for ${IDLE_SECONDS}s...`);
  await page.waitForTimeout(IDLE_SECONDS * 1000);

  const data = await page.evaluate(() => ({
    longTasks: window.__diagLongTasks ?? [],
    intervals: (window.__diagTimers?.intervals ?? []),
    timeouts: (window.__diagTimers?.timeouts ?? []),
    rafCount: window.__diagTimers?.rafCount ?? 0,
    wsFrames: window.__diagWsFrames ?? { sent: 0, received: 0, sentSamples: [], receivedSamples: [] },
  }));

  // Periodicity analysis: histogram of inter-task gaps.
  const gaps = [];
  const sortedTasks = [...data.longTasks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedTasks.length; i++) {
    gaps.push(sortedTasks[i].start - sortedTasks[i - 1].start);
  }
  const buckets = { "<50ms": 0, "50-100ms": 0, "100-250ms": 0, "250-500ms": 0, "500ms-1s": 0, "1-2s": 0, ">2s": 0 };
  for (const g of gaps) {
    if (g < 50) buckets["<50ms"]++;
    else if (g < 100) buckets["50-100ms"]++;
    else if (g < 250) buckets["100-250ms"]++;
    else if (g < 500) buckets["250-500ms"]++;
    else if (g < 1000) buckets["500ms-1s"]++;
    else if (g < 2000) buckets["1-2s"]++;
    else buckets[">2s"]++;
  }

  // Group intervals by ms — common periodic timer values surface here.
  const intervalByMs = {};
  for (const i of data.intervals) {
    const key = String(i.ms);
    intervalByMs[key] = (intervalByMs[key] ?? 0) + 1;
  }

  const payload = {
    idleSeconds: IDLE_SECONDS,
    longTaskCount: data.longTasks.length,
    longTaskTotalMs: Number(data.longTasks.reduce((a, b) => a + b.duration, 0).toFixed(1)),
    longTaskMaxMs: Number(Math.max(0, ...data.longTasks.map((t) => t.duration)).toFixed(1)),
    interTaskGapBuckets: buckets,
    interTaskGapsMs: gaps.map((g) => Number(g.toFixed(1))).slice(0, 100),
    intervalCount: data.intervals.length,
    intervalByMs,
    intervalSample: data.intervals.slice(0, 20),
    timeoutCount: data.timeouts.length,
    timeoutSample: data.timeouts.slice(0, 20),
    rafCount: data.rafCount,
    wsFramesSent: data.wsFrames.sent,
    wsFramesReceived: data.wsFrames.received,
    wsSentSamples: data.wsFrames.sentSamples,
    wsReceivedSamples: data.wsFrames.receivedSamples,
  };

  writeResult("diagnose-idle", payload);
  logSummary("diagnose-idle", {
    "Long tasks in 60s": payload.longTaskCount,
    "Total long-task time (ms)": payload.longTaskTotalMs,
    "rAF callbacks fired": payload.rafCount,
    "WS frames sent / received": `${payload.wsFramesSent} / ${payload.wsFramesReceived}`,
    "Intervals registered": payload.intervalCount,
    "Top interval ms values": Object.entries(intervalByMs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}ms×${v}`).join(", "),
    "Inter-task gaps (most common)": Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", "),
  });
} finally {
  await browser.close();
}
