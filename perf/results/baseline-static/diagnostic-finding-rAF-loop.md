# Idle long-task anomaly — root cause identified

## Symptom

`diagnose-idle.json` against the production build (`baseline-static` label) recorded:

- 446 long tasks in a 60-second idle window
- 41,573 ms cumulative long-task time (i.e. 69% of the window blocked)
- Longest single task: 4,515 ms
- 1,466 `requestAnimationFrame` callbacks (≈ 24 per second)
- **0 intervals registered, 0 timeouts firing during idle, 0 WS frames sent or received**

That combination is unusual: the page is "doing work" continuously but not via any common timer mechanism. The 24 rAFs/sec was the giveaway.

## Cause

`ui/src/components/AsciiArtAnimation.tsx` — a 348-line ASCII-art animation that runs a 24fps rAF loop with Float32Array physics, Math.sin/cos waves, and `<pre>.textContent` updates per frame.

```ts
// AsciiArtAnimation.tsx:3
const TARGET_FPS = 24;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
```

The component is mounted at:

- `ui/src/pages/Auth.tsx:180` (auth screen)
- `ui/src/components/OnboardingWizard.tsx:1267` (onboarding wizard)

A fresh `PAPERCLIP_HOME` with no completed onboarding resolves `/` to the onboarding state, so our harness was measuring the animation running on the wizard page, not a real dashboard. The numbers are real, but they apply to the onboarding screen, not the steady-state dashboard.

## Why each frame is so expensive (under 4× CPU throttle)

Per frame the component:

1. Re-measures glyph dimensions on resize (cheap when stable, but rebuildGrid recreates the Float32Arrays whenever container size changes by even one pixel).
2. Computes physics for every "clip" (sprite) — velocity, drift, life, position.
3. Updates two wave Float32Arrays (`colWave`, `rowWave`) with sin/cos lookups.
4. Updates the `trail` Float32Array (every cell).
5. Builds a `string[]` grid of `rows × cols` glyphs.
6. Joins the grid into a single string.
7. Sets `<pre>.textContent` to the new string.

Steps 5–7 are the real cost: `textContent =` triggers a layout/paint pass on the entire `<pre>`, and at typical onboarding viewport sizes the grid is ≥ 80 × 30 = 2,400 cells per frame.

## Why this matters even though it's "just the onboarding screen"

- It is the **first experience** for every new user. A wizard page that pegs the CPU sets the tone.
- The animation continues to run on the auth screen for any deployment in `authenticated` mode where users land on `/login`.
- It explains why the harness's `idle-polling` numbers looked alarming. Once we re-baseline against a post-onboarding dashboard (via the seed script), idle long-task counts should drop dramatically — and any remaining anomaly will be a real dashboard bug rather than this red herring.

## Suggested fixes (in increasing order of intrusiveness)

1. **Honor `prefers-reduced-motion` more strictly.** The component already checks the media query, but it should also check `document.visibilityState !== "visible"` to suspend when the page is hidden. (It does check `isVisible` — verify the suspend logic actually halts rAF rather than just skipping the render step.)
2. **Cap effective FPS to 12 on slow devices.** Use `requestIdleCallback` to detect "the previous frame took too long" and dynamically halve the FPS target.
3. **Switch the render target from `<pre>.textContent` to a `<canvas>`.** Drawing 2,400 monospace glyphs onto a canvas is cheaper than rebuilding a string + reflowing the DOM every frame. Same visual fidelity, much lower main-thread cost.
4. **Make the animation opt-in.** A static framed image of paperclips serves the brand purpose; the animation only fires when the user explicitly asks for it (or after the wizard is done loading async work).

## Implication for the optimization plan

This is **not** in the original audit's punch list — it's a separate finding. It's worth a dedicated PR (`perf/03-onboarding-animation` or similar) but it does not affect the chat-scroll, cold-load, ws-burst, or bundle items. Those still need their own fixes. The idle-polling and tab-refocus baselines should be re-captured against a seeded company before drawing conclusions about polling behavior.
