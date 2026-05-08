#!/usr/bin/env node
// ws-burst: stress-test how the UI handles a burst of live events. The harness
// monkey-patches `WebSocket` before the app boots, waits for the app to open
// at least one socket, then dispatches synthetic LiveEvent messages
// matching the shape `server/src/services/live-events.ts` emits and
// `ui/src/context/LiveUpdatesProvider.tsx` consumes.
//
// What this exercises:
//   * heartbeat.run.queued / heartbeat.run.status — drive the
//     `invalidateHeartbeatQueries` path (~6 invalidations per event).
//   * agent.status — drive the agent-list/dashboard/org invalidation path.
//   * activity.logged — drive the heaviest invalidation path
//     (issue list / detail / activity / sidebar badges).
//
// Pre-batching: 200 events × ~6 invalidateQueries each = 1200 immediate
// invalidations and 1200 corresponding refetches/re-renders. The page
// frequently fails to settle within 15s. With WsInvalidationBatcher, those
// 1200 raw invalidation calls collapse to ≤ ~30 unique query keys per 50 ms
// window — orders of magnitude less work.
//
// Output schema:
//   messagesFired              count actually dispatched into the open sockets
//   timeToIdleAfterBurstMs     time after the last fire until the page sees no
//                              long task for 250 ms (null if not within 15s)
//   longTasksAfterBurst        long tasks recorded during the settle window
//   droppedFramesAfterBurst    frames > 50 ms during the settle window

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, newPerfPage, loadBoardToken, attachBearer, baseUrl } from "./shared/browser.mjs";
import {
  installLongTaskObserver,
  installFrameCounter,
  summarizeFrames,
  summarizeLongTasks,
  waitForIdleAfter,
} from "./shared/metrics.mjs";
import { writeResult, logSummary } from "./shared/results.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = "ws-burst";
const PAGE_URL = baseUrl() + "/";
const ORIGIN = new URL(PAGE_URL).origin;
const BURST_COUNT = Number(process.env.PAPERCLIP_PERF_BURST_COUNT ?? 200);
const WS_WAIT_MS = Number(process.env.PAPERCLIP_PERF_WS_WAIT_MS ?? 10_000);

// The handler short-circuits if event.companyId doesn't match the active
// company, so the burst messages need the seeded company's id. Falling back
// to a stub id makes the scenario degrade gracefully when no seed has been
// run, but the burst won't actually exercise the invalidation paths in that
// case — note will be set in output.
function readSeededCompanyId() {
  try {
    const raw = fs.readFileSync(path.resolve(HERE, "..", "results", "seed-state.json"), "utf-8");
    return JSON.parse(raw)?.companyId ?? null;
  } catch {
    return null;
  }
}

const companyId = readSeededCompanyId();

const browser = await launch();
const { context, page } = await newPerfPage(browser);
await attachBearer(page, ORIGIN, loadBoardToken(ORIGIN));
await context.addInitScript(installLongTaskObserver);
await context.addInitScript(installFrameCounter);

await context.addInitScript(({ companyId, burstCount }) => {
  // Track every WebSocket the app opens.
  const OrigWS = window.WebSocket;
  const sockets = [];
  window.WebSocket = class extends OrigWS {
    constructor(url, protocols) {
      super(url, protocols);
      sockets.push(this);
    }
  };
  window.__perfWsSockets = sockets;

  // Build LiveEvent-shaped messages cycling across the four event types the
  // handler actually invalidates queries for. Each variant exercises a
  // distinct invalidation path inside LiveUpdatesProvider's helpers.
  const buildEvents = () => {
    if (!companyId) return [];
    const events = [];
    const baseAgents = Array.from({ length: 10 }, (_, i) => `synthetic-agent-${i}`);
    const baseRuns = Array.from({ length: 5 }, (_, i) => `synthetic-run-${i}`);
    const baseIssues = Array.from({ length: 8 }, (_, i) => `synthetic-issue-${i}`);
    for (let i = 0; i < burstCount; i++) {
      const variant = i % 4;
      const createdAt = new Date(Date.now() - i * 100).toISOString();
      let event;
      if (variant === 0) {
        // Triggers invalidateHeartbeatQueries (6+ invalidations)
        event = {
          id: 10_000 + i,
          companyId,
          type: "heartbeat.run.queued",
          createdAt,
          payload: { agentId: baseAgents[i % baseAgents.length], runId: baseRuns[i % baseRuns.length] },
        };
      } else if (variant === 1) {
        // Triggers invalidateHeartbeatQueries + buildRunStatusToast (heaviest path)
        event = {
          id: 10_000 + i,
          companyId,
          type: "heartbeat.run.status",
          createdAt,
          payload: {
            agentId: baseAgents[i % baseAgents.length],
            runId: baseRuns[i % baseRuns.length],
            status: i % 2 === 0 ? "succeeded" : "running",
          },
        };
      } else if (variant === 2) {
        // Triggers agent.status path (3 invalidations + agent detail)
        event = {
          id: 10_000 + i,
          companyId,
          type: "agent.status",
          createdAt,
          payload: { agentId: baseAgents[i % baseAgents.length], status: "active" },
        };
      } else {
        // Triggers invalidateActivityQueries — heaviest single path
        event = {
          id: 10_000 + i,
          companyId,
          type: "activity.logged",
          createdAt,
          payload: {
            entityType: "issue",
            entityId: baseIssues[i % baseIssues.length],
            action: i % 2 === 0 ? "issue.comment_added" : "issue.updated",
            actorType: "agent",
            actorId: baseAgents[i % baseAgents.length],
            details: {},
          },
        };
      }
      events.push(JSON.stringify(event));
    }
    return events;
  };

  window.__perfBurstEvents = buildEvents();

  window.__perfFireBurst = () => {
    let fired = 0;
    for (const ws of window.__perfWsSockets) {
      if (ws.readyState !== 1 /* OPEN */) continue;
      for (const data of window.__perfBurstEvents) {
        ws.dispatchEvent(new MessageEvent("message", { data }));
        fired++;
      }
    }
    return fired;
  };

  window.__perfWaitForOpenSocket = (timeoutMs) =>
    new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        const open = window.__perfWsSockets.find((ws) => ws.readyState === 1);
        if (open) return resolve(true);
        if (performance.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
}, { companyId, burstCount: BURST_COUNT });

try {
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const wsReady = await page.evaluate((ms) => window.__perfWaitForOpenSocket(ms), WS_WAIT_MS);
  const sockets = await page.evaluate(() => window.__perfWsSockets.length);

  let payload;
  if (!wsReady) {
    payload = {
      burstCount: BURST_COUNT,
      messagesFired: 0,
      timeToIdleAfterBurstMs: null,
      socketsObserved: sockets,
      note: `No open WebSocket within ${WS_WAIT_MS}ms — the dashboard may not have established its live-updates socket. Possible causes: lazy chunks still loading, auth state, or no companies loaded. Make sure perf/seed/seed-realistic.mjs has run and the dashboard route loaded.`,
    };
  } else {
    const burstStartedAt = await page.evaluate(() => performance.now());
    const fired = await page.evaluate(() => window.__perfFireBurst());
    const settleMs = await page.evaluate(
      waitForIdleAfter("__perfBurstStart__", 250, 15_000).replace("__perfBurstStart__", String(burstStartedAt)),
    );
    const longTasks = await page.evaluate(
      (since) => (window.__perfLongTasks ?? []).filter((t) => t.start >= since),
      burstStartedAt,
    );
    const lt = summarizeLongTasks(longTasks);
    const frameTimes = await page.evaluate(
      (since) => (window.__perfFrames?.times ?? []).filter((t) => t >= since),
      burstStartedAt,
    );
    const frames = summarizeFrames(frameTimes);
    payload = {
      burstCount: BURST_COUNT,
      messagesFired: fired,
      timeToIdleAfterBurstMs: settleMs >= 0 ? Number(settleMs.toFixed(1)) : null,
      socketsObserved: sockets,
      longTasksAfterBurst: lt,
      droppedFramesAfterBurst: frames.dropped,
      fpsDuringSettle: frames.fps,
      companyIdUsed: companyId,
      note: companyId
        ? undefined
        : "No seeded company id available — fired events will be filtered out by the handler's companyId guard.",
    };
  }

  writeResult(SCENARIO, payload);
  logSummary(SCENARIO, {
    "Messages fired": payload.messagesFired,
    "Sockets observed": payload.socketsObserved ?? 0,
    "Time to idle (ms)": payload.timeToIdleAfterBurstMs ?? "did not settle in 15s",
    "Long tasks during settle": payload.longTasksAfterBurst?.count ?? 0,
    "Dropped frames": payload.droppedFramesAfterBurst ?? 0,
  });
} finally {
  await browser.close();
}
