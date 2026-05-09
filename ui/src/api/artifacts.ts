import { api } from "./client";

export interface ArtifactRow {
  id: string;
  companyId: string;
  runId: string | null;
  issueId: string | null;
  kind: string;
  name: string;
  blobSha256: string;
  blobBytes: number;
  contentType: string;
  contentMeta: Record<string, unknown> | null;
  parentId: string | null;
  previewUrl: string | null;
  previewExpiresAt: string | null;
  previewProvider: string | null;
  declaredAt: string;
  declaredByAgentId: string | null;
  supersededAt: string | null;
  supersededById: string | null;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactRow[];
}

export interface GetArtifactResponse {
  artifact: ArtifactRow;
}

export function listArtifactsForIssue(
  issueId: string,
  opts: { includeSuperseded?: boolean; limit?: number } = {},
): Promise<ListArtifactsResponse> {
  const params = new URLSearchParams();
  if (opts.includeSuperseded) params.set("includeSuperseded", "true");
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return api.get<ListArtifactsResponse>(
    `/issues/${encodeURIComponent(issueId)}/artifacts${qs ? `?${qs}` : ""}`,
  );
}

export function getArtifact(id: string): Promise<GetArtifactResponse> {
  return api.get<GetArtifactResponse>(`/artifacts/${encodeURIComponent(id)}`);
}
