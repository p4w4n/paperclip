// Plugin contract for the Artifacts service. The default
// implementation (service.ts) is in-process; the same shape is the
// one a future plugin would provide.
//
// Tenant isolation is the service-layer concern (not the storage
// layer's). Every input carries companyId; assertTenant rejects
// cross-company calls before any side effect.

export interface ArtifactsServiceContext {
  callerCompanyId: string;
}

export interface DeclareInput {
  scope: {
    companyId: string;
    runId?: string;
    issueId?: string;
    declaredByAgentId?: string;
  };
  kind: string;
  // Logical name within the (issue, run) scope. For code.file kinds
  // this is the path; for docs a slug; for web.app a label.
  name: string;
  // Either inline bytes (server hashes + uploads) or a blob URI the
  // server can fetch (for large artifacts uploaded out-of-band).
  contentBytes?: Uint8Array;
  blobUri?: string;
  contentType: string;
  contentMeta?: Record<string, unknown>;
  requestPreview?: boolean;
}

export interface DeclareResult {
  id: string;
  // Whether this declaration superseded a prior version with the
  // same (issue_id, name).
  superseded: boolean;
  // True iff a preview job was enqueued (no preview provider for
  // the kind, or requestPreview was false → previewQueued=false).
  previewQueued: boolean;
}

export interface DeclaredArtifact {
  id: string;
  companyId: string;
  runId: string | null;
  issueId: string | null;
  kind: string;
  name: string;
  blobSha256: string;
  blobBytes: number;
  blobStorageProvider: string;
  blobStorageKey: string;
  contentType: string;
  contentMeta: Record<string, unknown> | null;
  parentId: string | null;
  previewUrl: string | null;
  previewExpiresAt: Date | null;
  previewProvider: string | null;
  declaredAt: Date;
  declaredByAgentId: string | null;
  supersededAt: Date | null;
  supersededById: string | null;
}

export interface ListInput {
  companyId: string;
  issueId?: string;
  runId?: string;
  // Default: only non-superseded rows. Pass true to include the
  // full history (UI revision view).
  includeSuperseded?: boolean;
  limit?: number;
}

export interface ForgetInput {
  id: string;
  companyId: string;
  reason: "user" | "expired" | "consolidated";
}

export interface ArtifactsService {
  declare(ctx: ArtifactsServiceContext, input: DeclareInput): Promise<DeclareResult>;
  list(ctx: ArtifactsServiceContext, input: ListInput): Promise<DeclaredArtifact[]>;
  get(
    ctx: ArtifactsServiceContext,
    input: { id: string; companyId: string },
  ): Promise<DeclaredArtifact | null>;
  forget(ctx: ArtifactsServiceContext, input: ForgetInput): Promise<void>;
}

// Surfaced through the API as a 403. Mirrors MemoryTenantMismatchError.
export class ArtifactsTenantMismatchError extends Error {
  constructor(callerCompanyId: string, inputCompanyId: string) {
    super(
      `artifacts tenant mismatch: caller company ${callerCompanyId} does not match input ${inputCompanyId}`,
    );
    this.name = "ArtifactsTenantMismatchError";
  }
}
