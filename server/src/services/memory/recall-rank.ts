// Pure scoring helper for the recall path. Two SQL queries hit the
// DB in parallel:
//
//   1. Vector cosine distance (when an embedder is configured and
//      pgvector is available).
//   2. Keyword ILIKE on `content` (always; serves as the pgvector-
//      absent fallback and as a recall-booster for exact-string
//      lookups when vectors miss).
//
// `mergeRecallResults` unions them by id with a weighted score and
// re-sorts. The weights match the spec — vector matches are
// preferred when present (0.7), keyword matches contribute the
// rest (0.3). For ids that match in both, the merged score is the
// sum (capped at 1.0).
//
// This module is pure so it's trivially unit-testable; the SQL
// emission lives in pgvector-backend.ts.

export interface ScoredHit {
  id: string;
  kind: "episodic" | "semantic" | "procedural";
  content: string;
  payload: Record<string, unknown> | null;
  sourceRunId: string | null;
  scopeKind: "user" | "company" | "agent" | "session";
  // Backend-specific raw score; vector = 1 - cosine_distance,
  // keyword = ts_rank-ish in [0,1].
  rawScore: number;
}

export interface MergedHit {
  id: string;
  kind: "episodic" | "semantic" | "procedural";
  content: string;
  payload: Record<string, unknown> | null;
  sourceRunId: string | null;
  scopeKind: "user" | "company" | "agent" | "session";
  score: number;
}

export const VECTOR_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;

export function mergeRecallResults(
  vectorHits: ScoredHit[],
  keywordHits: ScoredHit[],
  limit: number,
): MergedHit[] {
  const merged = new Map<string, MergedHit>();

  for (const h of vectorHits) {
    merged.set(h.id, {
      id: h.id,
      kind: h.kind,
      content: h.content,
      payload: h.payload,
      sourceRunId: h.sourceRunId,
      scopeKind: h.scopeKind,
      score: clamp(h.rawScore * VECTOR_WEIGHT),
    });
  }

  for (const h of keywordHits) {
    const existing = merged.get(h.id);
    const contribution = clamp(h.rawScore * KEYWORD_WEIGHT);
    if (existing) {
      existing.score = clamp(existing.score + contribution);
    } else {
      merged.set(h.id, {
        id: h.id,
        kind: h.kind,
        content: h.content,
        payload: h.payload,
        sourceRunId: h.sourceRunId,
        scopeKind: h.scopeKind,
        score: contribution,
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function clamp(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
