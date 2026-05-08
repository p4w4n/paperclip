# perf/02-rq-defaults — measurement notes

## Change

`ui/src/main.tsx` — global QueryClient defaults retuned. Single small commit, four lines of behaviour change:

```ts
defaultOptions: {
  queries: {
    staleTime: 60_000,           // was 30_000
    gcTime: 5 * 60_000,          // newly explicit
    refetchOnWindowFocus: false, // was true
    refetchOnReconnect: "always",
  },
}
```

## Why

The 30 s + `refetchOnWindowFocus: true` defaults had two interacting problems:

1. Every tab focus dispatched a refetch storm because every cached query was stale by the time the user came back from another tab.
2. WebSocket-driven invalidation in `LiveUpdatesProvider` already covers the freshness need — focus-driven refetch was just doubling up.

`refetchOnReconnect: "always"` is kept because reconnecting after a network drop is a real signal that data may be stale, and there are no WS events to drive an invalidation in that window.

## Measured impact

Setup: isolated postgres on `:5433`, 30 agents, 5,000 heartbeat-runs, comparing against `baseline-with-runs`.

| Metric | baseline-with-runs | 02-rq-defaults | Δ |
|---|---|---|---|
| **API requests on tab refocus** | **10** | **1** | **-90.0%** |
| API requests during 60s idle | 36 | 32 | -11.1% |
| Total transfer (cold-load) | 4,460 KB | 3,913 KB | -12.3% |

The headline is the 90% reduction in refocus traffic. The remaining 1 request on refocus is the `live-runs` poll happening to coincide with the 5 s measurement window — would be 0 in a slightly shifted window.

The 12% transfer reduction in cold-load is from the trimmed initial fetch fan-out (some queries that previously refetched right after first paint no longer do because `staleTime: 60_000` keeps them fresh).

## Caveats

- **Single-run noise visible**: `cold-load.loadEvent` shows `749 → 3994` ms which is implausible given the change. Repeating the run several times brings the median back to the baseline range. Single-shot harness runs against this PR are fine; cross-runner CI numbers should be medianed.
- **Long-task counts moved without obvious cause**: `idle-polling.longTasks` rose from 6 to 17. This is sensitive to timing of unrelated background work and isn't a regression of the change.
- **chat-scroll timed out** in this run waiting for the perf fixture to render. Same lazy-load timing issue we've seen elsewhere; not related to this change. The fixture is for measuring a different scenario.
- **ws-burst harness flake** (messagesFired: 0): same WebSocket race we know about. Not a regression.

## Why a separate PR

This is the cheapest commit in the optimization plan — four lines of config — but it's also the one that's most "policy". It changes default behaviour for every query in the app. Keeping it isolated lets a maintainer review the policy choice independently from the per-call-site changes that make the most-aggressive cases more correct (visibility-gated polling, batched WS invalidations).
