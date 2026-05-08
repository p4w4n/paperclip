// Drain state machine for the worker. The bidi server frame
// DrainRequested arrives during a MIG rolling update; the worker must
// finish in-flight runs, then end the stream cleanly so the server's
// connect-handler cleanup runs and the process can exit 0 (spec
// failure-mode "MIG rolling update — outgoing instances finish in-
// flight, disconnect; no run loss").
//
// Pure state machine — no gRPC, no process exit. Caller is responsible
// for honouring shouldReject() (sending RunFailed { errorCode:
// "worker_draining" } for new dispatches) and for the actual
// stream.end() / process.exit(0) inside onDrainComplete. Pure shape
// keeps the unit test free of timers and network.

export interface DrainGate {
  // Mark a run as in-flight. Called when handleRunDispatch starts.
  recordStart(runId: string): void;
  // Mark a run as done. Called from handleRunDispatch's finally block,
  // after RunComplete / RunFailed has been emitted. Idempotent —
  // duplicate ends are absorbed.
  recordEnd(runId: string): void;
  // Server pushed DrainRequested. Sets the draining flag (caller
  // checks shouldReject() on subsequent dispatches), and fires
  // onDrainComplete the moment in-flight reaches zero (or
  // synchronously if it's already zero). Idempotent.
  requestDrain(): void;
  // True once requestDrain() has been called. Caller honours this by
  // refusing new RunDispatches with a RunFailed { worker_draining }.
  shouldReject(): boolean;
}

export interface DrainGateOpts {
  onDrainComplete: () => void;
}

export function createDrainGate(opts: DrainGateOpts): DrainGate {
  // Tracking by runId rather than a counter so a duplicate recordEnd
  // (e.g., handler error path that decrements twice) doesn't drift the
  // count below zero and prematurely fire drain-complete.
  const inFlight = new Set<string>();
  let draining = false;
  let drainFired = false;

  const maybeFire = () => {
    if (draining && inFlight.size === 0 && !drainFired) {
      drainFired = true;
      opts.onDrainComplete();
    }
  };

  return {
    recordStart(runId) {
      inFlight.add(runId);
    },
    recordEnd(runId) {
      inFlight.delete(runId);
      maybeFire();
    },
    requestDrain() {
      if (draining) return; // idempotent
      draining = true;
      maybeFire();
    },
    shouldReject() {
      return draining;
    },
  };
}
