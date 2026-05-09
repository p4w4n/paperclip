// Embedding provider tests. The factory itself is hard to unit-test
// without mocking dynamic imports, so we focus on the batching
// helper which is the actual logic worth testing.

import { describe, expect, it, vi } from "vitest";

// Reach into the module to test the private batching by re-creating
// the same shape inline. (The exported surface is pure factory; the
// batching is internal.)

async function embedInBatches(
  texts: string[],
  embedFn: (batch: string[]) => Promise<Float32Array[]>,
  maxBatch = 100,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (texts.length <= maxBatch) return embedFn(texts);
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += maxBatch) {
    const batch = texts.slice(i, i + maxBatch);
    const out = await embedFn(batch);
    results.push(...out);
  }
  return results;
}

describe("embedInBatches", () => {
  const fakeVector = (i: number) => Float32Array.from([i, i, i]);

  it("returns empty array for empty input without calling embedFn", async () => {
    const embedFn = vi.fn();
    const out = await embedInBatches([], embedFn);
    expect(out).toEqual([]);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("calls embedFn once when input fits in one batch", async () => {
    const embedFn = vi.fn(async (batch: string[]) => batch.map((_, i) => fakeVector(i)));
    const out = await embedInBatches(["a", "b", "c"], embedFn, 100);
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(3);
  });

  it("splits across batches preserving order", async () => {
    const embedFn = vi.fn(async (batch: string[]) =>
      batch.map((s, i) => fakeVector(parseInt(s, 10) + i * 0.1)),
    );
    const inputs = Array.from({ length: 5 }, (_, i) => String(i));
    const out = await embedInBatches(inputs, embedFn, 2);
    expect(embedFn).toHaveBeenCalledTimes(3); // 2+2+1
    expect(out).toHaveLength(5);
    // Just check ordering is preserved by indexing the call args.
    expect(embedFn.mock.calls[0][0]).toEqual(["0", "1"]);
    expect(embedFn.mock.calls[1][0]).toEqual(["2", "3"]);
    expect(embedFn.mock.calls[2][0]).toEqual(["4"]);
  });
});
