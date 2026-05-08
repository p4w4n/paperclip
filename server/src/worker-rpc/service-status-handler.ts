// Plan 3 server-side: ServiceStatus frames from the worker map onto
// workspace_runtime_services row updates. Pure function over update +
// dispatched-owner-lookup callbacks so the unit tests can drive it
// without a real Drizzle handle.
//
// Late-frame drop semantics (Plan 2 Task 4) apply: if the sender's
// workerId doesn't match heartbeat_runs.dispatched_to_worker_id for
// the run AND the current owner is non-null, drop the frame —
// otherwise the row update would land from a worker that no longer
// owns the run (e.g., post-lease-expiry replay scenario).

export interface ServiceStatusUpdate {
  runId: string;
  runtimeServiceId: string;
  state: string;
  boundPort: number;
  url: string;
  error: string;
  errorCode: string;
  pid: number;
}

export interface ServiceStatusHandlerDeps {
  getCurrentDispatchedWorker: (runId: string) => Promise<string | null>;
  senderWorkerId: string;
  updateRow: (runtimeServiceId: string, patch: Record<string, unknown>) => Promise<void>;
  onDrop?: (input: { runId: string; runtimeServiceId: string; sender: string; currentOwner: string }) => void;
}

export async function handleServiceStatus(
  frame: ServiceStatusUpdate,
  deps: ServiceStatusHandlerDeps,
): Promise<void> {
  const currentOwner = await deps.getCurrentDispatchedWorker(frame.runId);
  if (currentOwner !== null && currentOwner !== deps.senderWorkerId) {
    deps.onDrop?.({
      runId: frame.runId,
      runtimeServiceId: frame.runtimeServiceId,
      sender: deps.senderWorkerId,
      currentOwner,
    });
    return;
  }

  const patch: Record<string, unknown> = {
    status: frame.state,
    updatedAt: new Date(),
  };
  if (frame.boundPort > 0) patch.port = frame.boundPort;
  if (frame.url) patch.url = frame.url;

  if (frame.state === "running") {
    patch.healthStatus = "healthy";
    patch.lastUsedAt = new Date();
  } else if (frame.state === "failed") {
    patch.healthStatus = "unhealthy";
  } else if (frame.state === "stopped") {
    patch.stoppedAt = new Date();
    patch.healthStatus = "unknown";
  }

  await deps.updateRow(frame.runtimeServiceId, patch);
}
