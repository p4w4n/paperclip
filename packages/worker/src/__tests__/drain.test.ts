// MIG rolling updates send DrainRequested → outgoing instances finish
// in-flight runs → end stream cleanly → process exits 0. Spec failure-
// mode "MIG rolling update — Drain frame to outgoing instances; they
// finish in-flight, send Bye, disconnect; no run loss".
//
// We don't ship a proto Bye message; ending the bidi stream is the
// disconnect signal. The drain gate below tracks in-flight count and
// fires onDrainComplete exactly once when the worker is safe to exit.

import { describe, it, expect, vi } from "vitest";
import { createDrainGate } from "../drain.js";

describe("createDrainGate", () => {
  it("fires onDrainComplete immediately when drain is requested with nothing in flight", () => {
    const onDrainComplete = vi.fn();
    const gate = createDrainGate({ onDrainComplete });
    gate.requestDrain();
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
  });

  it("waits for all in-flight runs to finish before firing onDrainComplete", () => {
    const onDrainComplete = vi.fn();
    const gate = createDrainGate({ onDrainComplete });
    gate.recordStart("r1");
    gate.recordStart("r2");
    gate.requestDrain();
    expect(onDrainComplete).not.toHaveBeenCalled();
    gate.recordEnd("r1");
    expect(onDrainComplete).not.toHaveBeenCalled();
    gate.recordEnd("r2");
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
  });

  it("fires onDrainComplete only once even on extra recordEnd calls", () => {
    const onDrainComplete = vi.fn();
    const gate = createDrainGate({ onDrainComplete });
    gate.recordStart("r1");
    gate.requestDrain();
    gate.recordEnd("r1");
    gate.recordEnd("r1"); // duplicate (e.g., handler error path double-decrements)
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
  });

  it("shouldReject is false until drain is requested, then true", () => {
    const gate = createDrainGate({ onDrainComplete: () => {} });
    expect(gate.shouldReject()).toBe(false);
    gate.requestDrain();
    expect(gate.shouldReject()).toBe(true);
  });

  it("a second requestDrain is a no-op (idempotent)", () => {
    const onDrainComplete = vi.fn();
    const gate = createDrainGate({ onDrainComplete });
    gate.requestDrain();
    gate.requestDrain();
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
  });

  it("dispatches arriving after drain don't count toward in-flight (caller rejects them)", () => {
    // The gate records what the caller chooses to record. If the caller
    // honours shouldReject() and skips recordStart for a drained
    // dispatch, the gate's in-flight count stays clean. This test pins
    // the contract — recordStart after drain is allowed but not
    // expected; recordEnd still works.
    const onDrainComplete = vi.fn();
    const gate = createDrainGate({ onDrainComplete });
    gate.recordStart("r1");
    gate.requestDrain();
    expect(gate.shouldReject()).toBe(true);
    // Caller would now reject any new dispatches; gate stays at
    // in-flight=1 from r1.
    gate.recordEnd("r1");
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
  });
});
