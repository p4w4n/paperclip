/**
 * Client-side store for disabled external adapter overrides.
 *
 * When an external adapter overrides a builtin type, the user may want to
 * pause the override (use the builtin parser) without hiding the type from
 * menus entirely.  This is separate from the server's per-type `disabled`
 * flag which controls menu visibility.
 *
 * Persisted to localStorage so it survives page reloads.
 *
 * Implements the React external store pattern (subscribe/getSnapshot)
 * so that components using useSyncExternalStore re-render on changes.
 */

const STORAGE_KEY = "paperclip:disabled-overrides";

let disabledOverrides = new Set<string>();

// ── React external store plumbing ────────────────────────────────────

/** Monotonically increasing version — changes on every mutation. */
let snapshotVersion = 0;

const listeners = new Set<() => void>();

/** Subscribe to store changes (for useSyncExternalStore). */
export function subscribeToOverrides(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Return a value that changes whenever the store changes.
 * React compares this with Object.is to decide whether to re-render.
 */
export function getOverridesSnapshot(): number {
  return snapshotVersion;
}

function emitChange(): void {
  snapshotVersion++;
  for (const fn of listeners) fn();
}

// ── Public API ───────────────────────────────────────────────────────

/** Check if the external override for a builtin type is paused. */
export function isOverrideDisabled(type: string): boolean {
  return disabledOverrides.has(type);
}

/** Pause or resume an external override. */
export function setOverrideDisabled(type: string, disabled: boolean): void {
  if (disabled) {
    disabledOverrides.add(type);
  } else {
    disabledOverrides.delete(type);
  }
  persist();
  emitChange();
}

/** Get all types with paused overrides (sync read). */
export function getDisabledOverrides(): Set<string> {
  return disabledOverrides;
}

// ── Persistence ──────────────────────────────────────────────────────

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabledOverrides]));
  } catch {
    // localStorage unavailable — no-op
  }
}

function hydrate(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      disabledOverrides = new Set(JSON.parse(raw));
    }
  } catch {
    // corrupt or unavailable — start empty
  }
}

// Hydrate on module load
hydrate();
