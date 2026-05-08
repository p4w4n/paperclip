// Worker-side reconnect loop. Plan 1's index.ts called startWorkerClient
// once and held the process open with `await new Promise(() => {})`; if
// the gRPC stream dropped (server restart, network blip, idle timeout)
// the worker stayed alive with a dead stream until MIG autohealing
// noticed. Plan 2 Task 5 wraps that single-call shape in a backoff
// loop so a stream drop transparently reconnects with the same
// workerId (spec NOTE N1: the server evicts the prior session on
// duplicate Hello).
//
// Pure function over (start, sleep, signal) — the test doesn't need
// real timers or a real gRPC stream. Production wiring in
// packages/worker/src/index.ts plugs in startWorkerClient as `start`,
// setTimeout as `sleep`, and process-SIGTERM as the abort source.

export interface ReconnectingHandle {
  // Resolves when the underlying connection has ended (stream EOF, error
  // event, or local close). The reconnect loop awaits this between
  // restarts. The actual handle will carry more (send / stop), but the
  // loop only needs to know when to back off and retry.
  closed: Promise<void>;
}

export interface ConnectWithBackoffOpts<H extends ReconnectingHandle> {
  start: () => Promise<H>;
  // Wait `ms` milliseconds before the next reconnect. Production wires
  // this to a setTimeout-promise; tests stub it as vi.fn() so timers
  // don't enter the picture.
  sleep: (ms: number) => Promise<void>;
  // Cap on the exponential backoff. Doubles starting at 1000ms; values
  // above the cap are clamped. 30_000 is the production default — long
  // enough that a flapping server doesn't get hammered, short enough
  // that recovery from a real outage is single-digit minutes.
  maxBackoffMs: number;
  // Caller-controlled abort. Production wires this to a SIGTERM handler
  // so a controlled shutdown (or test cleanup) breaks the loop instead
  // of looping forever on a closed stream.
  signal: AbortSignal;
}

export async function connectWithBackoff<H extends ReconnectingHandle>(
  opts: ConnectWithBackoffOpts<H>,
): Promise<void> {
  // Backoff grows monotonically: 1000, 2000, 4000, … capped at
  // maxBackoffMs. We don't reset on a successful connection — a worker
  // that thrashes through 30 second-long sessions in a row should
  // eventually back off rather than hammering the server every second.
  // If we ever need a "long-lived stream resets the dial" semantic,
  // that's a `reset-after-N-seconds-uptime` follow-up; v1 keeps the
  // simpler invariant.
  let attempt = 0;
  const backoffMs = (): number => Math.min(opts.maxBackoffMs, 1000 * 2 ** (attempt - 1));
  while (!opts.signal.aborted) {
    let handle: H;
    try {
      handle = await opts.start();
    } catch {
      // Transient failure on the start path (DNS blip, connect refused,
      // etc.). Same recovery shape as a stream drop: back off and
      // retry. The start callback is expected to log if it cares.
      attempt += 1;
      if (opts.signal.aborted) return;
      await opts.sleep(backoffMs());
      continue;
    }
    await handle.closed;
    if (opts.signal.aborted) return;
    attempt += 1;
    await opts.sleep(backoffMs());
  }
}
