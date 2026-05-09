import { describe, expect, it } from "vitest";
import { clusterRunsByTitle, type RunForCluster } from "../pattern-miner.js";

const r = (id: string, title: string, embedding?: Float32Array): RunForCluster => ({
  runId: id,
  title,
  titleEmbedding: embedding,
});

describe("clusterRunsByTitle", () => {
  it("returns no clusters under minClusterSize", () => {
    expect(
      clusterRunsByTitle([r("a", "deploy failed"), r("b", "deploy failed")], {
        minClusterSize: 3,
      }),
    ).toEqual([]);
  });

  it("clusters similar titles via Jaccard", () => {
    const runs = [
      r("a", "Deploy to staging failed"),
      r("b", "Staging deploy failed again"),
      r("c", "Deploy on staging failure"),
      r("d", "Add new feature"),
    ];
    const out = clusterRunsByTitle(runs, { minClusterSize: 3 });
    expect(out).toHaveLength(1);
    expect(out[0].size).toBe(3);
    expect(out[0].exemplarRunIds.length).toBeLessThanOrEqual(3);
  });

  it("uses embeddings when present (high cosine = same cluster)", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0.99, 0.01, 0]);
    const c = Float32Array.from([1, 0.05, 0]);
    const d = Float32Array.from([0, 1, 0]);
    const runs = [
      r("a", "x", a),
      r("b", "y", b),
      r("c", "z", c),
      r("d", "w", d),
    ];
    const out = clusterRunsByTitle(runs, { minClusterSize: 3, embeddingThreshold: 0.9 });
    expect(out).toHaveLength(1);
    expect(out[0].exemplarRunIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("signature is stable across re-runs", () => {
    const runs = [
      r("a", "deploy failed staging"),
      r("b", "Staging deploy fail"),
      r("c", "Failed staging deploy"),
    ];
    const a = clusterRunsByTitle(runs);
    const b = clusterRunsByTitle(runs);
    expect(a[0].signature).toBe(b[0].signature);
  });

  it("caps exemplars at maxExemplars", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      r(`r${i}`, "Deploy staging failed timeout"),
    );
    const out = clusterRunsByTitle(runs, { minClusterSize: 3, maxExemplars: 5 });
    expect(out[0].exemplarRunIds).toHaveLength(5);
    expect(out[0].size).toBe(10);
  });
});
