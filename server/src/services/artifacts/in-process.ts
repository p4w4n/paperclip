// In-process declare helper. claude-local / gemini-local run inside
// the server process; once those adapters expose a `declare_artifact`
// tool to the LLM (out of scope for v1), the tool implementation
// should resolve here.
//
// Until then this surface is also useful for routines, internal
// services, and tests that want to declare artifacts without
// hitting the REST layer.
//
// Failure mode: not initialized → throws. Caller decides whether
// the failure is fatal or absorbed. (Adapters should wrap in
// try/catch so a missing service doesn't crash a run.)

import { getArtifactsService } from "./service.js";
import type {
  DeclareInput,
  DeclareResult,
} from "./types.js";

export interface InProcessDeclareInput extends DeclareInput {
  // Required: caller proves it represents the same company as
  // input.scope.companyId. Mirrors the MemoryServiceContext pattern.
  callerCompanyId: string;
}

export async function declareArtifactInProcess(
  input: InProcessDeclareInput,
): Promise<DeclareResult> {
  const svc = getArtifactsService();
  const { callerCompanyId, ...declareInput } = input;
  return svc.declare({ callerCompanyId }, declareInput);
}
