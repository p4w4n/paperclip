import { useSyncExternalStore } from "react";

// Subscribe to document visibility changes. Returns true when the page is
// visible, false when the user has switched tabs / minimized / hidden the
// browser. Drives `refetchInterval` on poll-driven queries so background
// tabs stop hammering the control plane while the user isn't watching.
//
// Why a shared external store rather than a per-component hook:
//
// - `useSyncExternalStore` lets every consumer share the same subscription
//   and snapshot. React 18's tearing-free guarantee means all visible-gated
//   queries flip in the same render pass when the visibility changes.
// - The store is module-level and lazily attaches its listener on first
//   subscription, releases on last unsubscription. Idle pages with no
//   visible-gated queries pay nothing.
// - Tests that don't run in a browser get a stable `true` from
//   `getServerSnapshot` so SSR and node-based test renders don't error.
//
// Pattern used by polling call sites:
//
//   const visible = useIsVisible();
//   useQuery({
//     queryKey: ...,
//     queryFn: ...,
//     refetchInterval: visible ? 3000 : false,
//   });
//
// When the tab is backgrounded, react-query stops scheduling refetches
// until visibility returns. Combined with `staleTime: 60_000` from
// `main.tsx`, refetches resume on visibility-change only if the data is
// genuinely stale.

const subscribers = new Set<() => void>();
let attached = false;

function getSnapshot(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

function getServerSnapshot(): boolean {
  return true;
}

function notify() {
  for (const cb of subscribers) cb();
}

function attachIfNeeded() {
  if (attached || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", notify);
  attached = true;
}

function detachIfIdle() {
  if (!attached || subscribers.size > 0 || typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", notify);
  attached = false;
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  attachIfNeeded();
  return () => {
    subscribers.delete(callback);
    detachIfIdle();
  };
}

export function useIsVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
