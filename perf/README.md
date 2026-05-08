# perf/ — Paperclip UI performance harness

A reproducible harness for measuring Paperclip's web UI before and after optimization changes. Each scenario is a self-contained Node script that drives a headless Chromium against a running Paperclip instance and writes a JSON results file. `compare.mjs` diffs two result folders into a markdown table suitable for a PR description.

The harness is intentionally orthogonal to the existing `tests/e2e/` Playwright suite — those tests exist to catch correctness regressions, this exists to catch perf regressions. They share `@playwright/test` as a dependency and the `paperclipai onboard --yes --run` boot pattern.

## Why each scenario exists

| Scenario | Measures | Optimization items it validates |
|---|---|---|
| `chat-scroll` | Render commits, max commit duration, scroll long tasks, dropped frames during programmatic scroll on `/tests/perf/long-thread` | #1 (kill 1s elapsed timer), #11 (split IssueChatThread) |
| `cold-load` | FCP, domInteractive, JS bytes transferred, long tasks during boot | #5 (route-level code splitting), #9 (bundle audit) |
| `idle-polling` | API requests in a 60s idle window, top-offender path | #3 (visibility-gated polling), #10 (demote polling to WS-fallback) |
| `tab-refocus` | API requests in 5s after refocus | #2 (`refetchOnWindowFocus: false`), #4 (WS batching) |
| `ws-burst` | Time-to-idle after 200 synthetic WS messages, dropped frames during settle | #4 (batch WS invalidations), #14 (per-entity reducers) |
| `bundle` | Total dist bytes, JS bytes, top chunks | #5 (code splitting), #9 (bundle audit) |

## Quickstart

### One-time setup

```sh
pnpm install
pnpm exec playwright install chromium
```

### Run against your local dev server

```sh
# Terminal 1: boot Paperclip however you usually do
pnpm dev

# Terminal 2: capture a baseline
PAPERCLIP_PERF_LABEL=baseline node perf/run-all.mjs

# ... apply your changes, then ...
PAPERCLIP_PERF_LABEL=after-fix node perf/run-all.mjs

# Print the diff table
node perf/compare.mjs baseline after-fix
```

### Run against a throwaway Docker instance

```sh
docker compose -f perf/docker-compose.perf.yml up --build -d
PAPERCLIP_PERF_BASE_URL=http://localhost:3100 \
  PAPERCLIP_PERF_LABEL=baseline \
  node perf/run-all.mjs
docker compose -f perf/docker-compose.perf.yml down -v
```

### Run a single scenario

```sh
node perf/scenarios/chat-scroll.mjs
node perf/bundle/analyze.mjs
```

### Lighthouse CI (separate from the per-scenario scripts)

```sh
pnpm exec lhci autorun --config=./perf/lighthouse/lhci.config.cjs
```

Lighthouse output lands in `perf/results/<label>/lighthouse/`. Use it for cold-start metrics that need full Lighthouse rigor (FCP, LCP, TBT, CLS, SI under simulated 4G + 4× CPU). The `cold-load` scenario above is a faster, less-rigorous alternative for the same dimension that runs in <30s.

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `PAPERCLIP_PERF_BASE_URL` | `http://localhost:3100` | Where to find a running Paperclip server |
| `PAPERCLIP_PERF_LABEL` | git short SHA | Folder name under `perf/results/` |
| `PAPERCLIP_PERF_SHA` | git short SHA | Recorded inside each result file |
| `PAPERCLIP_PERF_CPU_THROTTLE` | `4` | CDP CPU throttling rate; matches Lighthouse "moderate" |
| `PAPERCLIP_PERF_BEARER_TOKEN` | (auto-detect from `~/.paperclip/auth.json`) | Auth token for non-trusted-mode instances |
| `PAPERCLIP_PERF_IDLE_SECONDS` | `60` | Length of `idle-polling` measurement window |
| `PAPERCLIP_PERF_BLUR_SECONDS` | `30` | `tab-refocus` blur duration before refocus |
| `PAPERCLIP_PERF_REFOCUS_WINDOW_SECONDS` | `5` | `tab-refocus` measurement window after refocus |
| `PAPERCLIP_PERF_BURST_COUNT` | `200` | `ws-burst` synthetic message count |
| `PAPERCLIP_PERF_SKIP` | (none) | Comma-separated scenario names to skip in `run-all.mjs` |

## How the determinism is enforced

- Every scenario launches Chromium via `scenarios/shared/browser.mjs`, which sets identical viewport (`1440x1000`), timezone (`Asia/Kolkata`), and CPU throttling rate (4×).
- All scenarios are sequential by default. Running them in parallel introduces CPU contention that destroys signal.
- Each scenario takes ≥1 sample but currently does NOT median several runs internally — that's a deliberate tradeoff for fast iteration. For the `compare.mjs` diff to be reliable, run each label 3× and pick the median manually, OR rely on the CI workflow's same-runner comparison (head vs base on the same `ubuntu-latest` instance, where noise is bounded).
- Lighthouse CI does median 5 runs per URL via `numberOfRuns: 5` — that's the authoritative source for cold-load metrics.

## Scenario output schema

Each scenario writes `perf/results/<label>/<scenario>.json` with shape:

```jsonc
{
  "scenario": "chat-scroll",
  "sha": "abc1234",
  "label": "baseline",
  "timestamp": "2026-05-08T12:34:56.000Z",
  "cpuThrottlingRate": 4,
  // ...scenario-specific fields, see scenario header comments
}
```

`compare.mjs` only renders the metrics declared in `SCENARIO_METRICS` at the top of `compare.mjs` — to add a new metric to the comparison table, edit that map. Everything else is captured in the JSON for ad-hoc analysis but stays out of the table to keep PR comments focused.

## Knobs you might want to turn

- **More iterations per scenario.** For high-confidence numbers, wrap each scenario in a `for (let i = 0; i < N; i++)` loop and emit `*-run-N.json` files. Add a median step to `compare.mjs`. We deliberately did NOT do this in the baseline because most signal comes from same-runner head-vs-base comparison.
- **More realistic synthetic data.** `ws-burst` uses placeholder message shapes. To make it precise, capture a real session via DevTools and replace `__perfBurstMessages` in `scenarios/ws-burst.mjs`.
- **Tighter Lighthouse thresholds.** `lighthouse/lhci.config.cjs` ships with permissive thresholds so baseline runs do not fail CI. After establishing a baseline, edit `assert.assertions` to lock in tighter limits as gates for future regressions.

## CI

`.github/workflows/perf.yml` runs the harness on every push to `perf/*` branches and on manual dispatch. Three jobs:

1. **bundle** — builds the UI, runs `bundle/analyze.mjs`, uploads `perf/results/`.
2. **scenarios** — boots Paperclip via `paperclipai onboard --yes --run`, runs `run-all.mjs`, uploads `perf/results/`.
3. **compare** — only runs when `compare_against` is provided as a workflow input; downloads both artifacts, runs `compare.mjs`, posts the markdown table as a PR comment.

For PR-driven workflows, the recommended pattern is:

1. Push the optimization branch (`perf/01-elapsed-timer`). CI runs the harness, uploads `perf-scenarios-<sha>` and `perf-bundle-<sha>` artifacts.
2. Trigger the `perf` workflow manually with `compare_against=baseline` to post the diff comment on the PR.

## Where the numbers go from here

This branch (`perf/baseline`) captures the unmodified-upstream measurements. Each subsequent optimization PR (`perf/01-…`, `perf/02-…`, etc.) should:

1. Run the harness with `PAPERCLIP_PERF_LABEL=<branch-suffix>`.
2. Commit the new results folder to `perf/results/<branch-suffix>/`.
3. Include the `compare.mjs` output in the PR description.

Ratchet the assertions in `lighthouse/lhci.config.cjs` and the SCENARIO_METRICS thresholds tighter after each merge so future regressions get caught.
