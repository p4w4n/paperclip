// Worker-side handler for ServerToWorker.RunDispatch frames. Realizes the
// requested workspace, fetches scoped secrets, invokes the adapter via the
// heartbeat-runner-shim, then reports outcome (RunComplete or RunFailed)
// + usage back to the control plane.
//
// All effectful collaborators (workspace realization, adapter invocation,
// secret fetch, frame send) come in as RunHandlerDeps so the handler can
// be unit-tested without touching the filesystem, network, or actual
// adapter binaries.
//
// What this DOES NOT yet do:
// - RunLog streaming. Adapter stdout/stderr → server is queued for the
//   adapter-shim work that lights up live log tails.
// - Lease renewal frames. Task 12 wires the periodic RunLeaseRenew
//   keepalive that survives long quiet runs (spec NOTE N2).
// - RunCancel handling. Cancel mid-run wires through the run-handler in
//   the same task that owns the cancellation pathway.

import { create } from "@bufbuild/protobuf";
import {
  WorkerToServerSchema,
  RunCompleteSchema,
  RunFailedSchema,
  RunUsageSchema,
  type RunDispatch,
  type WorkerToServer,
} from "@paperclipai/worker-rpc";

export interface RealizedWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
}

export interface AdapterInvocationContext {
  runId: string;
  agent: { id: string };
  config: Record<string, unknown>;
  cwd: string;
  env: Record<string, string | undefined>;
  context: Record<string, unknown>;
}

export interface AdapterOutcome {
  exitCode: number;
  signal: string | null;
  summary?: string;
  usage?: Record<string, unknown>;
}

export interface RunHandlerDeps {
  realizeWorkspace: (desc: Record<string, unknown>) => Promise<RealizedWorkspace>;
  runAdapter: (ctx: AdapterInvocationContext) => Promise<AdapterOutcome>;
  fetchSecrets: (token: string) => Promise<Record<string, string>>;
  send: (msg: WorkerToServer) => Promise<void>;
}

function decodeJson(bytes: Uint8Array | undefined): Record<string, unknown> {
  if (!bytes || bytes.length === 0) return {};
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Bad JSON shouldn't take down the worker — surface as an empty
    // config and let the adapter complain about missing fields with a
    // proper RunFailed.
    return {};
  }
}

export async function handleRunDispatch(
  d: RunDispatch,
  deps: RunHandlerDeps,
): Promise<void> {
  const adapterConfig = decodeJson(d.adapterConfigJson);
  const workspaceDesc = decodeJson(d.executionWorkspaceJson);

  let realized: RealizedWorkspace | null = null;
  try {
    const secrets = await deps.fetchSecrets(d.secretsScopeToken);
    realized = await deps.realizeWorkspace(workspaceDesc);

    const result = await deps.runAdapter({
      runId: d.runId,
      agent: { id: d.agentId },
      config: adapterConfig,
      cwd: realized.cwd,
      // Spec D2 secrets path: write nowhere, leak nothing — the adapter
      // sees secrets as env. tmpfs `.env` materialization (spec NOTE N3)
      // is layered on by Task 11's secret-fetcher when it actually has
      // values to write.
      env: { ...process.env, ...secrets },
      context: {},
    });

    if (result.usage) {
      await deps.send(
        create(WorkerToServerSchema, {
          payload: {
            case: "runUsage",
            value: create(RunUsageSchema, {
              runId: d.runId,
              usageJson: new TextEncoder().encode(JSON.stringify(result.usage)),
            }),
          },
        }),
      );
    }

    await deps.send(
      create(WorkerToServerSchema, {
        payload: {
          case: "runComplete",
          value: create(RunCompleteSchema, {
            runId: d.runId,
            exitCode: result.exitCode,
            signal: result.signal ?? "",
            summary: result.summary ?? "",
          }),
        },
      }),
    );
  } catch (err) {
    await deps.send(
      create(WorkerToServerSchema, {
        payload: {
          case: "runFailed",
          value: create(RunFailedSchema, {
            runId: d.runId,
            error: err instanceof Error ? err.message : String(err),
            errorCode: "worker_run_failed",
          }),
        },
      }),
    );
  } finally {
    // Cleanup runs even on failure — leaving an ephemeral workspace
    // around after a thrown adapter would leak disk on the worker over
    // time. Best-effort: a cleanup throw is logged but not propagated.
    if (realized) {
      try {
        await realized.cleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[worker] workspace cleanup failed for run", d.runId, err);
      }
    }
  }
}
