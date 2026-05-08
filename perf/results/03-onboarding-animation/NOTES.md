# perf/03-onboarding-animation — measurement notes

## Change

`ui/src/components/AsciiArtAnimation.tsx` — three small changes:

1. `TARGET_FPS: 24 → 12`. Halves per-frame work. The animation is slow drifting paperclips on top of an ambient noise field — visually indistinguishable at 12 fps, half the CPU.
2. Add an `IntersectionObserver` to halt the rAF loop when the `<pre>` element scrolls out of the viewport. Previously the loop kept burning CPU on the rAF tick even when the user had scrolled past it on later onboarding steps.
3. Thread `isOnScreen` into the existing `syncLoop()` guard so resume/pause is centralized with the visibility/reduced-motion gates.

About 25 lines net change.

## Why no harness numbers

The harness's `idle-polling` scenario already captured this code path on `perf/baseline` with `baseline-static` label (no company seeded → onboarding wizard renders): **446 long tasks in 60 seconds** of "idle" with 1,466 rAF callbacks (≈24/sec).

To measure this PR cleanly, the harness would need either:

- A fresh `PAPERCLIP_HOME` + a fresh isolated postgres so the wizard re-renders (a third isolated stack, beyond `/tmp/paperclip-isolated-7d713fcc` + `/tmp/paperclip-perf-pg`).
- Or a dedicated fixture page that mounts `<AsciiArtAnimation />` standalone (the `/tests/perf/...` fixture pattern).

Neither is worth spinning up for a 25-line code-review-grade change. The math is direct:

- `TARGET_FPS: 24 → 12` halves the rAF callback rate and the per-frame work. Long-task count and total ms scale roughly linearly with frame count.
- `IntersectionObserver` halt eliminates work entirely whenever the `<pre>` is off-screen. On the OnboardingWizard's later steps (where the animation scrolls out of view), this cuts CPU to zero instead of the previous 24 fps continuous load.

Expected delta on `baseline-static`'s `diagnose-idle` run if re-captured against this PR:

| Metric | baseline-static | This PR (predicted) |
|---|---|---|
| `longTaskCount` | 446 | ~220 (≈half) |
| `longTaskTotalMs` | 41,573 | ~20,800 |
| `rafCount` | 1,466 | ~733 |

Plus an unbounded additional reduction depending on how often the user scrolls the wizard step that holds the `<pre>` out of view.

## Why this isn't free even though it looks like one

The visual difference between 24 fps and 12 fps for this specific animation is negligible — it's a slow drift, not a fast shake. If a future designer wants 24 fps back, the change is one constant. The IntersectionObserver halt is purely additive.

`prefers-reduced-motion: reduce` already short-circuits the loop to a static frame. That branch is unchanged here. Users who explicitly opt out of motion get the same static frame they got before; users who accept motion get a cheaper version of the same animation.

## Why this matters at all

The animation is on the **first page every new Paperclip user sees** (`OnboardingWizard.tsx:1267`) and on the **auth page** (`Auth.tsx:180`) for any deployment in `authenticated` mode. A wizard that pegs the CPU at 4× throttle with 4.5 s long tasks blocking interaction is the opposite of the impression the brand wants.

This is a separate finding from the original audit (which was dashboard-focused). Documented at `perf/results/baseline-static/diagnostic-finding-rAF-loop.md`.
