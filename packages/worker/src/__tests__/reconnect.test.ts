// connectWithBackoff is the worker's reconnect loop. Pure function over
// (start, sleep, signal) so tests don't need real timers or a real gRPC
// stream — everything is plumbed via callbacks.
//
// The contract: call start() to open a connection, await the handle's
// `closed` promise (resolves on stream EOF / error), sleep an
// exponentially growing backoff, repeat. Caller stops via AbortSignal.

import { describe, it, expect, vi } from "vitest";
import { connectWithBackoff } from "../reconnect.js";

function manualClose(): { handle: { closed: Promise<void> }; close: () => void } {
  let resolve!: () => void;
  const closed = new Promise<void>((r) => {
    resolve = r;
  });
  return { handle: { closed }, close: resolve };
}

describe("connectWithBackoff", () => {
  it("calls start, awaits closed, then re-starts after sleep", async () => {
    const c1 = manualClose();
    const c2 = manualClose();
    const handles = [c1.handle, c2.handle];
    const start = vi.fn(async () => handles.shift()!);
    const sleep = vi.fn(async () => {});
    const ctrl = new AbortController();

    const loop = connectWithBackoff({ start, sleep, maxBackoffMs: 30_000, signal: ctrl.signal });

    // First connection — wait for it to be opened, then end the stream.
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    c1.close();

    // Loop should sleep, then re-start.
    await Promise.resolve();
    await Promise.resolve();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenLastCalledWith(1000); // attempt=1 → 1s
    expect(start).toHaveBeenCalledTimes(2);

    // Tell the second connection to die too. Then abort to exit cleanly.
    c2.close();
    await Promise.resolve();
    await Promise.resolve();
    ctrl.abort();
    await loop;
  });

  it("doubles backoff up to maxBackoffMs (cap)", async () => {
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
    });
    const closes: Array<() => void> = [];
    const start = vi.fn(async () => {
      const c = manualClose();
      closes.push(c.close);
      return c.handle;
    });
    const ctrl = new AbortController();
    const loop = connectWithBackoff({ start, sleep, maxBackoffMs: 5_000, signal: ctrl.signal });

    // Drive 5 disconnect cycles; expect 1s, 2s, 4s, 5s, 5s (cap kicks in).
    for (let i = 0; i < 5; i++) {
      // Wait for the next start() to register a close handle.
      while (closes.length <= i) await Promise.resolve();
      closes[i]();
      // Let the sleep + next-start microtasks land.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    ctrl.abort();
    // Close the last open connection so the loop wakes up to see the abort.
    if (closes.length > 5) closes[5]();
    await loop;

    expect(slept).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it("stops cleanly on AbortSignal without re-starting", async () => {
    const c1 = manualClose();
    const start = vi.fn(async () => c1.handle);
    const sleep = vi.fn(async () => {});
    const ctrl = new AbortController();

    const loop = connectWithBackoff({ start, sleep, maxBackoffMs: 30_000, signal: ctrl.signal });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    ctrl.abort();
    c1.close();
    await loop;

    // No second start, no sleep — abort short-circuits before backoff.
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries the start callback if it throws (e.g., transient connect failure)", async () => {
    let calls = 0;
    const c1 = manualClose();
    const start = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("connect refused");
      return c1.handle;
    });
    const sleep = vi.fn(async () => {});
    const ctrl = new AbortController();

    const loop = connectWithBackoff({ start, sleep, maxBackoffMs: 30_000, signal: ctrl.signal });
    // First start throws → loop sleeps → second start succeeds.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);

    ctrl.abort();
    c1.close();
    await loop;
  });
});
