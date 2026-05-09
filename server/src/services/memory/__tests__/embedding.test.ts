// Embedding provider tests. The factory itself is hard to unit-test
// without mocking dynamic imports, so we focus on the batching
// helper which is the actual logic worth testing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider } from "../embedding.js";

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

describe("createEmbeddingProvider — ollama", () => {
  const origFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function ok(body: unknown) {
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  }

  it("returns null when the daemon is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const provider = await createEmbeddingProvider({ provider: "ollama" });
    expect(provider).toBeNull();
  });

  it("refuses to bind when the model emits a non-1024 dimension", async () => {
    // 768-dim model probe (e.g. nomic-embed-text)
    fetchMock.mockResolvedValueOnce(
      ok({ embeddings: [Array(768).fill(0.1)] }),
    );
    const provider = await createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
    });
    expect(provider).toBeNull();
  });

  it("binds when the model emits 1024-dim", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ embeddings: [Array(1024).fill(0.1)] }),
    );
    const provider = await createEmbeddingProvider({ provider: "ollama" });
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe("ollama");
    expect(provider?.dimension).toBe(1024);
  });

  it("embed() POSTs to /api/embed and returns Float32Arrays", async () => {
    // probe
    fetchMock.mockResolvedValueOnce(
      ok({ embeddings: [Array(1024).fill(0.0)] }),
    );
    const provider = await createEmbeddingProvider({ provider: "ollama" });
    expect(provider).not.toBeNull();

    // embed call
    const v1 = Array(1024).fill(0.1);
    const v2 = Array(1024).fill(0.2);
    fetchMock.mockResolvedValueOnce(ok({ embeddings: [v1, v2] }));
    const out = await provider!.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(1024);
    expect(out[0][0]).toBeCloseTo(0.1, 4);

    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toContain("/api/embed");
    expect(JSON.parse(lastCall?.[1].body as string)).toEqual({
      model: "bge-m3",
      input: ["a", "b"],
    });
  });

  it("embed() throws when the daemon errors", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ embeddings: [Array(1024).fill(0)] }),
    );
    const provider = await createEmbeddingProvider({ provider: "ollama" });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      async text() {
        return "model not loaded";
      },
    });
    await expect(provider!.embed(["x"])).rejects.toThrow(/500/);
  });
});

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
