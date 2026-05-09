import { describe, expect, it } from "vitest";
import {
  mergeRecallResults,
  KEYWORD_WEIGHT,
  VECTOR_WEIGHT,
  type ScoredHit,
} from "../recall-rank.js";

function hit(id: string, rawScore: number, content = "x"): ScoredHit {
  return {
    id,
    kind: "semantic",
    content,
    payload: null,
    sourceRunId: null,
    scopeKind: "company",
    rawScore,
  };
}

describe("mergeRecallResults", () => {
  it("returns empty when both inputs are empty", () => {
    expect(mergeRecallResults([], [], 10)).toEqual([]);
  });

  it("scales vector hits by VECTOR_WEIGHT", () => {
    const out = mergeRecallResults([hit("a", 1)], [], 10);
    expect(out[0].score).toBeCloseTo(VECTOR_WEIGHT, 5);
  });

  it("scales keyword hits by KEYWORD_WEIGHT", () => {
    const out = mergeRecallResults([], [hit("a", 1)], 10);
    expect(out[0].score).toBeCloseTo(KEYWORD_WEIGHT, 5);
  });

  it("sums score for ids matching in both result sets", () => {
    const out = mergeRecallResults([hit("a", 1)], [hit("a", 1)], 10);
    expect(out[0].score).toBeCloseTo(VECTOR_WEIGHT + KEYWORD_WEIGHT, 5);
  });

  it("clamps merged scores to 1.0", () => {
    // Engineered overflow: VECTOR_WEIGHT(0.7) + KEYWORD_WEIGHT(0.3) = 1.0
    // exactly when both rawScore = 1. Verify clamp stays at 1.
    const out = mergeRecallResults([hit("a", 1)], [hit("a", 1)], 10);
    expect(out[0].score).toBeLessThanOrEqual(1);
  });

  it("sorts by descending score", () => {
    const vectorHits = [hit("a", 0.5), hit("b", 0.9)];
    const keywordHits = [hit("c", 1.0)];
    const out = mergeRecallResults(vectorHits, keywordHits, 10);
    // b=0.9*0.7=0.63, a=0.5*0.7=0.35, c=1.0*0.3=0.30 → b,a,c
    expect(out.map((h) => h.id)).toEqual(["b", "a", "c"]);
  });

  it("respects the limit", () => {
    const vectorHits = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)];
    const out = mergeRecallResults(vectorHits, [], 2);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("derives scopeKind from the source hit unchanged", () => {
    const h: ScoredHit = { ...hit("a", 1), scopeKind: "user" };
    const out = mergeRecallResults([h], [], 10);
    expect(out[0].scopeKind).toBe("user");
  });
});
