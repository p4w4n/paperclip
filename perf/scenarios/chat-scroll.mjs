#!/usr/bin/env node
// chat-scroll: render /tests/perf/long-thread (1500-message chat fixture),
// scroll programmatically, capture React Profiler commit metrics + Long Tasks
// + dropped-frame counts during the scroll.
//
// This is the headline scenario for items #1 (1s timer kills perf) and #11
// (split the 4,300-line IssueChatThread). A clean-up there should drop
// scrollLongTasks.totalMs and longestTaskMs significantly.
//
// Output schema:
//   renderReadyMs            — time from goto() to virtualizer ready
//   commitCount              — React profiler commits during mount
//   mountActualDurationMs    — first commit duration
//   maxActualDurationMs      — worst commit during mount
//   scrollResponsiveMs       — main-thread block during programmatic scroll
//   scrollDroppedFrames      — frames > 50ms during scroll window
//   scrollFps                — observed FPS during scroll
//   longTasks                — { count, totalMs, maxMs } over full scenario

import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import { installLongTaskObserver, installFrameCounter, summarizeFrames, summarizeLongTasks } from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const SCENARIO = "chat-scroll";
const PAGE_URL = `${baseUrl()}/tests/perf/long-thread`;
const ORIGIN = new URL(PAGE_URL).origin;

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installLongTaskObserver);
await context.addInitScript(installFrameCounter);

try {
  const t0 = Date.now();
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="issue-chat-long-thread-perf"]', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const target = Number(document.querySelector('[data-testid="perf-fixture-row-target"]')?.textContent ?? "450");
    const virtualizer = document.querySelector('[data-testid="issue-chat-thread-virtualizer"]');
    if (!virtualizer) return document.querySelectorAll('[data-testid="issue-chat-message-row"]').length >= target;
    const virtualCount = Number(virtualizer.getAttribute("data-virtual-count") ?? "0");
    return virtualCount >= target;
  }, null, { timeout: 60_000 });
  const renderReadyMs = Date.now() - t0;

  // Programmatic scroll, measure main-thread block.
  const scrollMetrics = await page.evaluate(async () => {
    const target = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const startY = window.scrollY;
    const startedAt = performance.now();
    window.scrollTo({ top: target, behavior: "instant" });
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => requestAnimationFrame(() => r()));
    return {
      scrollResponsiveMs: Number((performance.now() - startedAt).toFixed(1)),
      scrollDeltaPx: Math.round(Math.abs(window.scrollY - startY)),
      documentHeightPx: Math.round(document.documentElement.scrollHeight),
    };
  });

  // Let the page settle so deferred work shows up in long-tasks before we sample.
  await page.waitForTimeout(500);

  const profilerMetrics = await page.evaluate(() => {
    const text = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? "";
    const num = (id) => {
      const v = Number(text(id).replace(/\s*ms$/, ""));
      return Number.isFinite(v) ? v : null;
    };
    const virtualizer = document.querySelector('[data-testid="issue-chat-thread-virtualizer"]');
    return {
      virtualCount: Number(virtualizer?.getAttribute("data-virtual-count") ?? "0"),
      rowCount: document.querySelectorAll('[data-testid="issue-chat-message-row"]').length,
      markdownRows: Number(text("perf-fixture-markdown-rows")),
      commitCount: Number(text("perf-commit-count")),
      mountActualDurationMs: num("perf-mount-duration"),
      latestActualDurationMs: num("perf-latest-duration"),
      maxActualDurationMs: num("perf-max-duration"),
      totalActualDurationMs: num("perf-total-duration"),
    };
  });

  const { longTasks, frameTimes } = await page.evaluate(() => ({
    longTasks: window.__perfLongTasks ?? [],
    frameTimes: window.__perfFrames?.times ?? [],
  }));

  const frames = summarizeFrames(frameTimes);
  const lt = summarizeLongTasks(longTasks);

  const payload = {
    renderReadyMs,
    ...profilerMetrics,
    ...scrollMetrics,
    scrollDroppedFrames: frames.dropped,
    scrollFps: frames.fps,
    longTasks: lt,
  };

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    renderReadyMs: `${renderReadyMs} ms`,
    commitCount: profilerMetrics.commitCount,
    maxActualDurationMs: `${profilerMetrics.maxActualDurationMs} ms`,
    scrollResponsiveMs: `${scrollMetrics.scrollResponsiveMs} ms`,
    droppedFrames: `${frames.dropped} / ${frames.total} (${frames.fps} fps)`,
    longTasks: `${lt.count} (max ${lt.maxMs} ms, total ${lt.totalMs} ms)`,
  });
} finally {
  await browser.close();
}
