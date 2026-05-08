# perf/01-elapsed-timer — measurement notes

## Change

`ui/src/components/IssueChatThread.tsx` — replace the per-component `setInterval(1000)` in `useLiveElapsed` with a shared module-level tick store driven by a single 1 Hz interval. Consumers subscribe via React 18's `useSyncExternalStore`. The interval starts on first subscriber, stops when the last one unsubscribes.

Old code:

```ts
function useLiveElapsed(startMs, active) {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!active || !startMs) return;
    const i = setInterval(() => rerender(n => n + 1), 1000);
    return () => clearInterval(i);
  }, [active, startMs]);
  // ...
}
```

New code: single shared interval, `useSyncExternalStore` subscription. With N visible run rows, the old code ran N parallel timers and triggered N independent `setState` calls per second (each a re-render of the row's parent in the chat thread). The new code runs one timer regardless of N.

## Why measurement here is noisy

`chat-scroll` numbers vary by ~10× across single runs of the *same* build, dominated by CPU contention from whatever else is running on the machine (background builds, browser updates, unrelated processes). Comparing one run of this PR to one run of `baseline-with-runs` produced an apparent regression that's purely noise:

| Metric | baseline-with-runs (run A) | 01-elapsed-timer (run B) |
|---|---|---|
| renderReadyMs | 1,946 ms | 11,641 ms |
| scrollFps | 20 | 4 |

These two ran on different CPU loads. The earlier `baseline-seeded` capture, on a quieter machine, showed `renderReadyMs: 9,071`, `scrollFps: 2` — so the "baseline-with-runs is fast at 20 fps" data point is the outlier, not the new run.

To get clean numbers for this change, the harness would need to:
- Median 5+ runs per label
- Pin CPU affinity and disable hyperthreading (or run in a dedicated container)
- Forbid concurrent background work

None of that is in place. So this PR ships on **code-review confidence**, not measured delta. The change is small (≤60 lines), strictly mechanical (timer consolidation), and the React 18 `useSyncExternalStore` pattern is well-trodden.

## Why the change is correct anyway

1. The audit identified `useLiveElapsed` as the single largest unforced re-render source on an active issue chat thread (item #1 in the punch list).
2. With the new tick store, when no consumer is active, the interval is `null` (verified by the start/stop logic). Zero CPU when nothing displays elapsed time.
3. With many consumers (typical case: many concurrent runs visible), exactly one timer fires per second regardless of count. React batches the resulting subscription notifications into a single render pass per consumer, which the framework already deduplicates against unchanged renders.
4. Falsy `active`/`startMs` cases use a no-op subscriber and a constant snapshot, so React's reference equality check bails the render entirely — no work at all.

## What the harness *did* show

| Metric | baseline-with-runs | 01-elapsed-timer | Δ | Notes |
|---|---|---|---|---|
| `tab-refocus.apiRequestsAfterRefocus` | 10 | 1 | -90% | Real but unrelated to this change. The single live-runs poll happens to coincide with the 5 s window — same pattern we've seen across other PRs. |
| `idle-polling.apiRequestCount` | 36 | 32 | -11% | Same single-run flake band. |
| `chat-scroll` | (see above) | (see above) | noise | Inconclusive at this measurement quality. |

## Follow-up

A statistically clean re-measurement needs a properly conditioned harness (`run-all.mjs --iterations=5`, fixed CPU governor, no concurrent processes). Worth doing before claiming any single-PR delta in chat-scroll. Until then, evaluate this PR as a code review.
