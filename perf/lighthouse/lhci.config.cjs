// Lighthouse CI config for capturing FCP / LCP / TBT / CLS / SI on cold load.
//
// Targets two URLs:
//   /                              — the dashboard (requires a logged-in
//                                    instance; in local_trusted mode this is
//                                    fine, in authenticated mode set
//                                    PAPERCLIP_PERF_BEARER_TOKEN and run
//                                    Lighthouse via Playwright instead — see
//                                    scenarios/cold-load.mjs).
//   /tests/perf/long-thread        — the chat fixture, no auth needed; isolates
//                                    a single hot path so the metrics are easy
//                                    to interpret.
//
// CPU/network throttling defaults match Lighthouse "moderate" profile so
// numbers correspond to widely-published baselines (mobile 4G + 4x CPU slow).

const baseUrl = (process.env.PAPERCLIP_PERF_BASE_URL || "http://localhost:3100").replace(/\/$/, "");

module.exports = {
  ci: {
    collect: {
      url: [`${baseUrl}/`, `${baseUrl}/tests/perf/long-thread`],
      numberOfRuns: 5,
      settings: {
        preset: "desktop",
        throttlingMethod: "simulate",
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 4,
        },
        skipAudits: ["uses-http2", "redirects-http"],
        // The fixture page sits behind a SPA route; skip the offline check.
        onlyCategories: ["performance"],
      },
    },
    assert: {
      preset: "lighthouse:no-pwa",
      assertions: {
        // These thresholds become the baseline gates. Tighten them as the
        // optimization PRs land. They are intentionally loose initially so
        // baseline runs do not fail CI — they are a safety net, not a target.
        "first-contentful-paint": ["warn", { maxNumericValue: 4000 }],
        "largest-contentful-paint": ["warn", { maxNumericValue: 6000 }],
        "total-blocking-time": ["warn", { maxNumericValue: 1500 }],
        "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],
        interactive: ["warn", { maxNumericValue: 7000 }],
      },
    },
    upload: {
      // Default: write reports to ./perf/results/<label>/lighthouse/. The
      // upload server target can be overridden via env in CI for permanent
      // dashboards (Temporary Public Storage is fine for ad-hoc).
      target: "filesystem",
      outputDir: `./results/${process.env.PAPERCLIP_PERF_LABEL || "local"}/lighthouse`,
      reportFilenamePattern: "%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%",
    },
  },
};
