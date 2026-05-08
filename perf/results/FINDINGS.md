# Baseline findings — UI performance audit, May 2026

Three labels were captured. Each tells a different story; together they map the surface.

| Label | What it measured | Why it matters |
|---|---|---|
| `baseline` | UI in **vite-dev-middleware** mode (HMR enabled, source modules served). Inflated bundle and noise. | Discarded — `paperclipai onboard --yes --run` auto-enables `PAPERCLIP_UI_DEV_MIDDLEWARE=true` from a monorepo source checkout. Set `PAPERCLIP_UI_DEV_MIDDLEWARE=false` explicitly to defeat. Kept in the repo as evidence. |
| `baseline-static` | UI in **static mode** (production build served from `ui/dist`), but **no company seeded** — landing page is the OnboardingWizard. | Captures the bundle correctly. Idle-polling looks alarming but is the onboarding ASCII animation, not a real polling problem. |
| `baseline-seeded` | Static mode, **30 agents seeded** via `perf/seed/seed-realistic.mjs`. Landing page redirects to `/PER/dashboard`. | The honest baseline. This is what to compare optimization PRs against. |

## Headline numbers (from `baseline-seeded`, except where noted)

```
cold-load
  FCP                  3,544 ms      ← real dashboard, post-redirect to /PER/dashboard
  domInteractive         686 ms
  loadEventEndMs       3,365 ms
  longTasks (count/max/total)   8 / 2,476 ms / —
  jsBytes              3,606 KB across 1 file (the 3.6 MB index chunk)

chat-scroll  (uses /tests/perf/long-thread fixture; same regardless of seed)
  renderReadyMs        9,071 ms     ← 9 SECONDS to first ready
  maxActualDurationMs  5,427 ms     ← single React commit took 5.4s
  scrollResponsiveMs   1,119 ms
  scrollFps                2        ← TWO frames per second
  longTasks            count=6, max=5,769 ms, total=10,711 ms

idle-polling  (60s idle, dashboard with 30 agents)
  apiRequestCount         23
  Top offender         /api/companies/:id/live-runs   (7 hits in 60s = every ~8.5s)
  Other one-shots      issues, projects, agents, sidebar-prefs, approvals, etc.
  longTasks            count=9, total=3,503 ms, max=1,792 ms

tab-refocus  (30s blur, then 5s window after refocus)
  apiRequestsAfterRefocus  1   ← only live-runs; refetchOnWindowFocus seems mostly harmless on this dashboard
  longTasksAfterRefocus    0

ws-burst
  messagesFired             200
  timeToIdleAfterBurstMs    null  ← did not settle within 15s
  longTasksAfterBurst       count=6, total ~3,500 ms
  droppedFramesAfterBurst   6

bundle  (production build, from `baseline-static` — same for any label)
  totalBytes           7.6 MB
  jsBytes              7.5 MB across 169 files
  largest chunk        3.6 MB   ← assets/index-FWfI3djl.js (the main entry)
  next-largest         498 KB   mermaid.core
                       453 KB   treemap
                       441 KB   cytoscape.esm
                       258 KB   katex
```

## Diagnostic finding — the AsciiArtAnimation rabbit hole

In `baseline-static` (no seed), `idle-polling` recorded **431 long tasks in 60s** with 0 timers, 0 WS frames, but ~24 `requestAnimationFrame` callbacks per second. Source: `ui/src/components/AsciiArtAnimation.tsx` (348 lines, used by `pages/Auth.tsx` and `components/OnboardingWizard.tsx`). At 24fps with a Float32Array physics simulation rendering ASCII to a `<pre>.textContent`, it runs continuously while the wizard is mounted.

Once the company is seeded, the wizard never mounts and the long-task count drops from 431 to 9 — confirming the animation was the cause. Full notes in `baseline-static/diagnostic-finding-rAF-loop.md`.

This is **not** in the original audit's punch list. Worth a separate PR (`perf/03-onboarding-animation`). It does not affect any of the optimization items measured against `baseline-seeded`.

## What each optimization PR should target

Use `baseline-seeded` as the reference label.

| # | PR | Expected delta | Headline metric |
|---|---|---|---|
| 1 | `perf/01-elapsed-timer` (kill 1s timer in IssueChatThread) | scrollFps ↑, longTasks max ↓ | `chat-scroll.scrollFps`, `longTasks.maxMs` |
| 2 | `perf/02-rq-defaults` (staleTime, refetchOnWindowFocus) | very small here — refocus is already mild | `tab-refocus.apiRequestsAfterRefocus` |
| 3 | `perf/03-onboarding-animation` (defer/canvas-ize the rAF loop) | enormous on `/`, near-zero on `/PER/dashboard` | re-measure with `baseline-static` label |
| 4 | `perf/04-visibility-gated-polling` (gate live-runs polling on visibility) | idle apiRequestCount ↓ from 23 to ~6 | `idle-polling.apiRequestCount` |
| 5 | `perf/05-ws-batching` (batch invalidations in LiveUpdatesProvider) | ws-burst time-to-idle drops from `null` to <1s | `ws-burst.timeToIdleAfterBurstMs` |
| 6 | `perf/06-route-code-split` (lazy routes + manualChunks) | jsBytes ↓ massively, FCP ↓ | `cold-load.jsBytes`, `bundle.topJsChunks[0].size` |
| 7 | `perf/07-elapsed-tick-store` (extract tick store from IssueChatThread) | chat-scroll commit count ↓, max duration ↓ | `chat-scroll.maxActualDurationMs`, `commitCount` |

The biggest wins by impact-per-hour: **#6 (code split the 3.6 MB chunk)** and **#5 (WS batching)**. Item **#1** is the simplest standalone change. Items **#2** and **#4** are the visibility-gating work.

## How to reproduce

```sh
# 1. Boot Paperclip in static (production-build) mode on :5001
mkdir -p /tmp/paperclip-perf-home
PORT=5001 \
  PAPERCLIP_HOME=/tmp/paperclip-perf-home \
  PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  PAPERCLIP_UI_DEV_MIDDLEWARE=false \
  pnpm paperclipai onboard --yes --run &

# 2. Wait for health
until curl -sf http://localhost:5001/api/health > /dev/null; do sleep 2; done

# 3. Build the UI (one time per branch)
pnpm --filter @paperclipai/ui build
# Now /tmp/paperclip/ui/dist exists, server picks it up.

# 4. Seed
PAPERCLIP_PERF_BASE_URL=http://localhost:5001 \
  node perf/seed/seed-realistic.mjs

# 5. Run the harness
PAPERCLIP_PERF_BASE_URL=http://localhost:5001 \
  PAPERCLIP_PERF_LABEL=baseline-seeded \
  node perf/run-all.mjs

# 6. Compare against an optimization label
node perf/compare.mjs baseline-seeded my-optimization-label
```

## Open issues with the harness itself

- **ws-burst is still a scaffold.** The synthetic message shapes don't match real LiveEventType payloads, so the "did not settle in 15s" might be lower-bound (real messages might cause more or less work than placeholders). Replace `__perfBurstMessages` in `scenarios/ws-burst.mjs` with captured real session events for an authoritative number.
- **Each scenario runs once.** No median-of-N. CI same-runner head-vs-base comparisons are reliable; cross-runner aren't. For local before/after work, run each label 3× and pick the median manually.
- **The seed is light.** 30 agents but 0 issues. Once `perf/05-…` lands (issue creation API exercised), add a "20 issues with 200 messages each" seed step so chat-thread fixture and live-events queries see realistic load.
- **The cold-load `jsBytes` is `3,606 KB` (one file).** That's because nothing else gets pre-loaded eagerly on dashboard mount. Code splitting will *not* reduce this number much unless we move significant work out of `index.tsx`. The bundle scenario captures the more interesting "what's lazy-loadable" story via topJsChunks.
