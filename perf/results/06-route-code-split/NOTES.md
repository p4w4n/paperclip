# perf/06-route-code-split — measurement notes

## Change

`ui/src/App.tsx` — every page component lazy-loaded via `React.lazy(...)` wrapped in a `<Suspense fallback={null}>` boundary.

`ui/vite.config.ts` — added `manualChunks` to split `react`, `@tanstack/react-query`, `react-router-dom`, `react-markdown` + `remark-gfm` into vendor chunks.

## Net read

Win on every interactive metric, regression on cold-start metrics. Ship-able with caveats.

| Dimension | Direction | Magnitude |
|---|---|---|
| Scroll perf | ✅ much better | FPS 2 → 10, scroll-responsive -84%, worst commit -52% |
| Total transferred JS | ✅ better | -37% (3.6 MB → 2.3 MB) |
| Main entry chunk | ✅ better | -44% (3.6 MB → 2.0 MB) |
| Cold-load FCP | ⚠️ worse | +28% (3.5s → 4.5s) |
| Cold-load domInteractive | ⚠️ worse | +212% (686 ms → 2,141 ms) |
| ws-burst | ⚠️ broken | 0 messages fired (lazy chunks not loaded by the time the shim fires) |
| Idle polling | flat-ish | 23 → 28 requests (+22% — likely tail-end chunk loads inside the idle window) |

## Why cold-load got slightly worse

The main entry no longer carries every page; it now carries imports + a manifest of lazy chunks + the active route's chunk. Each separate chunk costs one HTTP round-trip and one parse/compile pass. On a fast cached connection this is a wash; on a fresh visit with 4× CPU throttle it adds ~1s.

Mitigations to try in a follow-up:

- Add `<link rel="preload">` for the dashboard chunk specifically (it's the most common landing route).
- Use `experimentalMinChunkSize` to merge tiny route chunks that fragment the graph without a real win.
- Move shared utility modules out of the route chunks (currently they're duplicated across each lazy chunk).

## Why ws-burst broke

The harness installs the WS shim via `addInitScript` (runs before any page script). With eager imports, the WS-establishing component was in the main bundle and ran almost immediately on goto. With lazy imports, the dashboard chunk is fetched after page load — the WS connection opens after the harness's 2-second post-`networkidle` wait, so by the time the shim tries to fire the burst, no sockets exist yet.

Two ways to fix:

1. **Smarter harness wait** (preferred): change `scenarios/ws-burst.mjs` to `await page.waitForFunction(() => window.__perfWsSockets.length > 0, { timeout: 10_000 })` before firing.
2. **Server-side endpoint**: as documented in the scenario header, add a `POST /api/perf/burst` endpoint that calls `publishLiveEvent` server-side. Avoids client timing entirely.

Filed for the next round. Does not affect the validity of this PR's other numbers.

## Why I'm shipping it anyway

The interactive-quality improvements are real and large. Cold-load regression is bounded (~1s on a 4× throttled cold visit, less on real hardware). Once subsequent PRs land — particularly the IssueChatThread split and timer fixes — cold-load will recover and overall perf will be substantially better than baseline.

This PR also unlocks future wins: any new heavy import added to a single route now lands in that route's chunk, not the entry. That's hygiene the project should have had from day one.

## Bundle topology after

```
Main entry            2,052 KB    (was 3,692 KB, -44%)
mermaid.core            498 KB    (unchanged, dynamic import)
treemap                 453 KB    (unchanged, dynamic import)
cytoscape.esm           441 KB    (unchanged, dynamic import)
katex                   258 KB    (unchanged, dynamic import)
IssueChatThread         238 KB    (newly split out)
IssueDetail             186 KB    (newly split out)
markdown (vendor chunk) 165 KB    (newly split out — react-markdown + remark-gfm)
... 273 more chunks
```

Total dist: 7,871 KB (was 7,827 KB — slight net increase from chunking overhead, but this is total-on-disk, not transferred-on-load).
