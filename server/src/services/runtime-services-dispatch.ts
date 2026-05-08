// Plan 3 dispatch projection. workspace-runtime.ts already knows how
// to enumerate the runtime services for a run (config-driven, with
// reuse-key resolution and per-entry env templating). When the run is
// being dispatched to a worker, we need the same list translated into
// the proto's RuntimeServiceSpec shape so the worker can spawn each.
//
// Pure function — no DB I/O, no spawn — so the unit tests are
// independent of workspace_runtime_services fixtures and adapter
// config schemas. The caller (P3-6 wiring inside workspace-runtime.ts)
// resolves entries and passes them in already in their final form.

import { create } from "@bufbuild/protobuf";
import {
  RuntimeServiceSpecSchema,
  type RuntimeServiceSpec,
} from "@paperclipai/worker-rpc";

export interface ResolvedRuntimeServiceEntry {
  // Stable id from the workspace_runtime_services row. The worker
  // echoes it on every ServiceStatus so the server connect-handler
  // can match the update to a row without re-resolving by name.
  runtimeServiceId: string;
  serviceName: string;
  command: string;
  // When omitted, the projection falls back to the workspace cwd. A
  // service that runs in a sub-directory of the realized workspace
  // (e.g., a monorepo's apps/api/) sets its own cwd here.
  cwd?: string;
  // Per-entry env. Merged onto the adapter env; entry env wins on key
  // conflict because services may want narrower scopes than the
  // overall adapter run (e.g., NODE_ENV=development for a dev server
  // even when the adapter is otherwise running in production mode).
  env?: Record<string, string>;
  readyPort?: number;
  readyHealthcheckUrl?: string;
  // 0 = use worker default (60s).
  readinessTimeoutSec?: number;
}

export interface BuildRuntimeServiceSpecsInput {
  entries: ResolvedRuntimeServiceEntry[];
  workspaceCwd: string;
  adapterEnv: Record<string, string>;
}

export function buildRuntimeServiceSpecs(input: BuildRuntimeServiceSpecsInput): RuntimeServiceSpec[] {
  return input.entries.map((entry) =>
    create(RuntimeServiceSpecSchema, {
      runtimeServiceId: entry.runtimeServiceId,
      serviceName: entry.serviceName,
      command: entry.command,
      cwd: entry.cwd ?? input.workspaceCwd,
      env: { ...input.adapterEnv, ...(entry.env ?? {}) },
      readyPort: entry.readyPort ?? 0,
      readyHealthcheckUrl: entry.readyHealthcheckUrl ?? "",
      readinessTimeoutSec: entry.readinessTimeoutSec ?? 0,
    }),
  );
}
