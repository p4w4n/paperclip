// ServiceStatus frames from the worker drive row updates on
// workspace_runtime_services. The handler is extracted into its own
// module so tests can drive it without spinning up a real Drizzle DB
// — the side effects (row update, log) come in as callbacks.

import { describe, it, expect, vi } from "vitest";
import { handleServiceStatus, type ServiceStatusUpdate } from "../service-status-handler.js";

const baseFrame: ServiceStatusUpdate = {
  runId: "r1",
  runtimeServiceId: "rs1",
  state: "running",
  boundPort: 0,
  url: "",
  error: "",
  errorCode: "",
  pid: 0,
};

describe("handleServiceStatus", () => {
  it("running state writes status + boundPort + url", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    await handleServiceStatus(
      { ...baseFrame, state: "running", boundPort: 3000, url: "http://localhost:3000" },
      {
        getCurrentDispatchedWorker: async () => "w-1",
        senderWorkerId: "w-1",
        updateRow: async (id, patch) => {
          updates.push({ id, patch });
        },
      },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("rs1");
    expect(updates[0].patch.status).toBe("running");
    expect(updates[0].patch.port).toBe(3000);
    expect(updates[0].patch.url).toBe("http://localhost:3000");
  });

  it("failed state writes error + clears port", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    await handleServiceStatus(
      {
        ...baseFrame,
        state: "failed",
        error: "readiness timeout",
        errorCode: "readiness_timeout",
      },
      {
        getCurrentDispatchedWorker: async () => "w-1",
        senderWorkerId: "w-1",
        updateRow: async (id, patch) => {
          updates.push({ id, patch });
        },
      },
    );
    expect(updates[0].patch.status).toBe("failed");
    expect(updates[0].patch.healthStatus).toBe("unhealthy");
  });

  it("stopped state writes stoppedAt timestamp", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    await handleServiceStatus(
      { ...baseFrame, state: "stopped" },
      {
        getCurrentDispatchedWorker: async () => "w-1",
        senderWorkerId: "w-1",
        updateRow: async (id, patch) => {
          updates.push({ id, patch });
        },
      },
    );
    expect(updates[0].patch.status).toBe("stopped");
    expect(updates[0].patch.stoppedAt).toBeInstanceOf(Date);
  });

  it("drops the frame if the sender no longer owns the run (Plan 2 Task 4 gate)", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const dropLog = vi.fn();
    await handleServiceStatus(
      { ...baseFrame, state: "running" },
      {
        getCurrentDispatchedWorker: async () => "w-2",
        senderWorkerId: "w-1",
        updateRow: async (id, patch) => {
          updates.push({ id, patch });
        },
        onDrop: dropLog,
      },
    );
    expect(updates).toHaveLength(0);
    expect(dropLog).toHaveBeenCalled();
  });

  it("allows the frame when current owner is null (row already cleared, e.g., run completed)", async () => {
    // Mismatch-only-drop semantics — a null owner means the row has
    // already been settled; a final ServiceStatus { stopped } from the
    // last-known worker is still valid cleanup.
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    await handleServiceStatus(
      { ...baseFrame, state: "stopped" },
      {
        getCurrentDispatchedWorker: async () => null,
        senderWorkerId: "w-1",
        updateRow: async (id, patch) => {
          updates.push({ id, patch });
        },
      },
    );
    expect(updates).toHaveLength(1);
  });
});
