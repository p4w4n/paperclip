// Debounced wake signal for the work-queue scheduler.
//
// Webhook ingestion calls pokeScheduler() so a freshly-enqueued
// item doesn't have to wait up to 30s for the next heartbeat
// tick. The heartbeat loop subscribes via onPoke() — when poked
// AND the last drain was longer than min_interval_ms ago, it
// runs an early drain.
//
// Debounce shape: per-company; multiple pokes in a 1-second
// window collapse to a single wake. The poke object is module-
// global because the heartbeat loop and the webhook handler
// don't share a context object.

const DEFAULT_DEBOUNCE_MS = 1000;

type Listener = (companyId: string | null) => void;

let listeners: Listener[] = [];
const lastPoked = new Map<string, number>();

export interface PokeOpts {
  debounceMs?: number;
  // Override now() — tests use it.
  now?: () => number;
}

export function pokeScheduler(companyId: string | null = null, opts: PokeOpts = {}): boolean {
  const debounce = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now?.() ?? Date.now();
  const key = companyId ?? "*";
  const last = lastPoked.get(key) ?? 0;
  if (now - last < debounce) return false; // collapsed
  lastPoked.set(key, now);
  for (const fn of listeners) {
    try {
      fn(companyId);
    } catch {
      /* listener bugs shouldn't kill the poker */
    }
  }
  return true;
}

export function onPoke(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function clearPokeListeners(): void {
  listeners = [];
  lastPoked.clear();
}
