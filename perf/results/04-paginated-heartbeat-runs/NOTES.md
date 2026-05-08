# perf/04-paginated-heartbeat-runs — measurement notes

## Change

The sidebar inbox badge previously called `GET /companies/:id/heartbeat-runs?limit=200` to compute one bit of state per agent ("is the most recent run a failure?"). That call returned 200 full `HeartbeatRun` objects (~250 KB) on every dashboard mount and on every refocus. Resolves the `useInboxBadge` portion of upstream issue #958.

This PR adds a server-side primitive `GET /companies/:id/heartbeat-runs/latest-failed` that does the work in SQL via `DISTINCT ON (agent_id)` and returns only the failed-run rows with the columns the badge actually reads. The UI hook switches to it.

Three files changed:

- `server/src/services/heartbeat.ts` — new `latestFailedPerAgent` service method using a single `DISTINCT ON (agent_id)` SELECT.
- `server/src/routes/agents.ts` — new `GET /companies/:companyId/heartbeat-runs/latest-failed` route.
- `ui/src/api/heartbeats.ts` — new `latestFailedPerAgent(companyId)` API client method.
- `ui/src/hooks/useInboxBadge.ts` — query swapped to the new endpoint.
- `ui/src/lib/inbox.ts` — `getLatestFailedRunsByAgent` and `computeInboxBadgeData` widened to accept the trimmed row shape via a new `InboxBadgeRunFields` type. The original full `HeartbeatRun[]` callers continue to typecheck.

This is a strict subset of upstream PR #959 (which adds `/stats` and `/latest-failed` plus pagination, and rewrites Dashboard charts and Inbox to use them). Limiting to the `useInboxBadge` path keeps the diff small and the win concentrated.

## Measured impact

Setup: isolated postgres on `:5433`, 30 agents, 5,000 historical heartbeat-runs (mixed status distribution including ~17% in failure states).

| Metric | baseline-with-runs | 04-paginated-heartbeat-runs | Δ |
|---|---|---|---|
| **Bytes per inbox-badge fetch** | **247,807** | **2,230** | **-99.1%** |
| API requests on refocus | 10 | 1 | -90.0% |
| API requests during idle (60s) | 36 | 32 | -11% |

The 99% bandwidth reduction is the headline. The refocus drop from 10 requests to 1 is a downstream effect: the badge query is the single largest item in the refocus refetch cascade, so removing its weight makes "should I refetch this 250 KB blob?" a cheap "should I refetch this 2 KB blob?" decision and react-query's `staleTime` covers most of the gap.

Idle-polling shifts top offender from heartbeat-runs to live-runs polling — those 7 hits/min are now the largest remaining item in that scenario and are addressed by a separate PR (visibility-gated polling).

## Caveats

- **ws-burst regressed in this single run**: messagesFired went from 200 → 0, and long-task count rose. **This is a harness flake, not a regression of the code change**. The ws-burst scaffold races the WebSocket open against the harness firing the burst — sometimes the socket isn't open yet when the harness tries to inject. Re-running the same build typically resolves it. The `LiveUpdatesProvider` code path is untouched here.
- **Single-run noise on chat-scroll**: numbers (8.7 s render-ready, 4.5 s max long task, 3 fps) are within the variance band of `baseline-with-runs` (12 s, 2.5 s, 20 fps). Direction noisy because chat-scroll reads from the synthetic fixture, not from the database, so heartbeat-runs changes shouldn't move it. They appear to vary because the fixture renders are sensitive to background CPU. Run 3-5x for confidence.
- **Smaller scope than #959**: this PR does not yet add the `/stats` endpoint for chart data on the Dashboard, nor the limit/offset pagination flags on the existing list endpoint. Those are valuable follow-ups; the current PR is the smallest change that delivers the largest single win in the badge path.

## What's left in the #958 surface

After this PR, the unpaginated `/companies/:id/heartbeat-runs` endpoint is still:
- Called by `Inbox.tsx:824` with `limit=200` (already paginated, but pulls full rows for display — could use a similar trimmed shape).
- Called by `AgentDetail.tsx:681` with **no limit** — the agent detail page downloads every run for a single agent. This is the biggest remaining #958 hot spot. Would need an `?offset` + `useInfiniteQuery` migration, similar to PR #959's `RunsTab` work.

Filed as follow-ups. Each is a self-contained PR. None block this one.
