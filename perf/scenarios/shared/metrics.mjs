// In-page metric collectors. Each function returns a snippet of JS to evaluate
// inside the browser via page.evaluate(). Keeping them as strings (rather than
// passing functions) avoids bundling/serialization issues with closures.
//
// All times are in milliseconds; counts are integers.

export const installLongTaskObserver = `
  window.__perfLongTasks = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perfLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    obs.observe({ type: "longtask", buffered: true });
    window.__perfLongTaskObserver = obs;
  } catch (e) {
    window.__perfLongTaskInitError = String(e);
  }
`;

export const installFrameCounter = `
  window.__perfFrames = { times: [], rafId: null };
  const tick = (t) => {
    window.__perfFrames.times.push(t);
    window.__perfFrames.rafId = requestAnimationFrame(tick);
  };
  window.__perfFrames.rafId = requestAnimationFrame(tick);
`;

export const installNetworkCounter = `
  window.__perfNet = { fetches: [], xhrs: [] };
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    window.__perfNet.fetches.push({ url, t: performance.now() });
    return origFetch.apply(this, arguments);
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const x = new OrigXHR();
    const origOpen = x.open;
    x.open = function(method, url) {
      window.__perfNet.xhrs.push({ url, t: performance.now() });
      return origOpen.apply(x, arguments);
    };
    return x;
  };
`;

// Returns the number of frames where the gap to the previous frame exceeded
// `budgetMs` (i.e. dropped/long frames). 16.7ms budget = 60fps target.
export function summarizeFrames(times, budgetMs = 50) {
  if (!times || times.length < 2) return { dropped: 0, total: 0, fps: 0 };
  let dropped = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > budgetMs) dropped++;
  }
  const span = times[times.length - 1] - times[0];
  const fps = span > 0 ? Math.round(((times.length - 1) * 1000) / span) : 0;
  return { dropped, total: times.length, fps };
}

export function summarizeLongTasks(tasks) {
  if (!tasks || tasks.length === 0) return { count: 0, totalMs: 0, maxMs: 0 };
  let totalMs = 0;
  let maxMs = 0;
  for (const t of tasks) {
    totalMs += t.duration;
    if (t.duration > maxMs) maxMs = t.duration;
  }
  return {
    count: tasks.length,
    totalMs: Number(totalMs.toFixed(1)),
    maxMs: Number(maxMs.toFixed(1)),
  };
}

// Wait until the page has been idle for `quietMs`, defined as no long tasks
// recorded in that window. Used to measure "time to settle after a burst".
export const waitForIdleAfter = (sinceTime, quietMs = 250, timeoutMs = 10_000) => `
  (async () => {
    const since = ${sinceTime};
    const quiet = ${quietMs};
    const timeout = ${timeoutMs};
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const recent = (window.__perfLongTasks || []).filter(t => t.start >= since);
      if (recent.length === 0) {
        await new Promise(r => setTimeout(r, quiet));
        const stillRecent = (window.__perfLongTasks || []).filter(t => t.start >= since);
        if (stillRecent.length === 0) return performance.now() - since;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return -1;
  })()
`;
