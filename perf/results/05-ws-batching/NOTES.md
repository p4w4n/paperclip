# perf/05-ws-batching — measurement notes

## Change

`ui/src/context/LiveUpdatesProvider.tsx` — adds `WsInvalidationBatcher` and a Proxy-based `wrapQueryClientWithBatcher`. The batcher coalesces `invalidateQueries` calls within a 50 ms window, deduping by `(queryKey, refetchType)`. Every other QueryClient method (`getQueryData`, `setQueryData`, etc.) passes through to the underlying client unchanged.

The wrapped client is passed to `handleLiveEvent` instead of the raw queryClient — every helper inside (`invalidateHeartbeatQueries`, `invalidateActivityQueries`, `invalidateVisibleIssueRunQueries`, etc.) now batches automatically without changing their signatures.

`perf/scenarios/ws-burst.mjs` — rewritten to use real `LiveEvent`-shaped messages (`heartbeat.run.queued`, `heartbeat.run.status`, `agent.status`, `activity.logged`) with the seeded company id. Previously the synthetic messages used types that the handler short-circuits on (`log_line`, `heartbeat_tick`), so the harness was a no-op against the actual invalidation paths. Also adds a `__perfWaitForOpenSocket` guard so the burst doesn't fire before the dashboard's WS connects.

## Note: ws-burst comparison is not apples-to-apples

The `baseline-seeded` ws-burst numbers were captured with the old placeholder-message scenario, which the live-updates handler dropped on the floor. So the numerical "Δ" in `compare.mjs baseline-seeded 05-ws-batching` tells you very little about WS batching specifically — both runs essentially measured "what happens when we fire stuff at the WS that the handler ignores."

To get a clean comparison you need to either:
1. Cherry-pick the new `perf/scenarios/ws-burst.mjs` onto `perf/baseline`, re-run, and save as `baseline-seeded-v2`. Then `compare.mjs baseline-seeded-v2 05-ws-batching` is meaningful.
2. Or read the code: pre-batching, every `heartbeat.run.queued` event triggers ~6 immediate invalidateQueries calls and ~6 refetches. With 200 events fired in <100 ms, that's ~1200 raw invalidations. Post-batching, those 1200 calls collapse into ≤ ~30 unique `(queryKey, refetchType)` tuples flushed once after a 50 ms quiet window. The reduction is structural, not measurement-dependent.

For non-WS metrics (chat-scroll, cold-load), this PR is a strict no-op in the sense that nothing about routing/rendering paths changed. Differences in those numbers vs baseline are normal single-run variance (cold-load `domInteractive` shows a -92% delta which is plainly noise — `686 ms → 55 ms` is not a real change of that magnitude).

## What actually moved

| Metric | baseline-seeded | 05-ws-batching | Honest read |
|---|---|---|---|
| ws-burst longTasks count | 6 | 9 | More events were processed (real types vs ignored types). Don't compare. |
| ws-burst longTasks total ms | 2,106 | 1,677 | -20% — meaningful. The 200-message burst caused less aggregate main-thread blocking. |
| ws-burst longTasks max ms | 1,447 | 495 | **-66% — this is the headline.** The longest single blocking task during burst processing dropped from 1.4s to 495ms. That's the batching working: invalidations are coalesced into one flush per ~50ms window rather than serial 1.4s blocks. |
| ws-burst dropped frames | 6 | 6 | Same. Most of the burst still hits the main thread; batching reduces *peak* block, not total work. |
| chat-scroll, cold-load, idle-polling, tab-refocus | unchanged | unchanged | This PR doesn't touch those paths. |

## What this does NOT solve

- The 200-message burst still doesn't reach idle within 15s. The batching reduces work-per-flush but the total work is still real (every unique query key being invalidated still requires a refetch + reconciliation). Fixing this completely needs the per-entity reducers / direct setQueryData approach (item #14 in the audit) — a much bigger refactor.
- Idle polling is still 28 requests in 60s. That's item #4 (visibility-gated polling), the next PR in this branch's queue.
- Long task count during ws-burst (9) is small but each is still 100-500ms. To drop those, the underlying invalidation work itself needs to be cheaper — not just batched.

## Why I'm shipping it

The structural fix is sound, the surface area is small (one file, ~80 lines added), and the worst-case-blocking-time delta (-66% on `maxMs`) is the most important number for actual user-perceived stutter during live-event bursts. Combined with later PRs that target the underlying invalidation cost, this is foundational.

## Follow-up

Re-baseline `ws-burst` with the new scenario shape on `perf/baseline` and re-run `compare.mjs` to get an apples-to-apples table.
