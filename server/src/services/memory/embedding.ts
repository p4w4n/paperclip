// Embedding provider abstraction. Two production options:
//   - voyage-3-large (default): MTEB 2026 leader at retrieval; ~10%
//     better than text-embedding-3-large per voyage's benchmark.
//   - text-embedding-3-large (fallback): OpenAI default; safe choice
//     when a tenant doesn't have a Voyage account.
//
// Both SDKs are lazy-imported — unit tests that don't exercise the
// production providers don't pay the load cost. Same pattern as the
// gcpIdTokenAuthStrategy in workers Plan 1 Task 14.
//
// Default dimension is 1024 (matches the schema's vector(1024)). For
// providers that emit 3072-dim by default (text-embedding-3-large at
// full size), we configure them to truncate to 1024 — the spec's
// int8 quantization recommendation lands as a follow-up in Plan 2.

const MAX_BATCH = 100;

export interface EmbeddingProvider {
  id: "voyage-3-large" | "text-embedding-3-large";
  dimension: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingProviderOpts {
  // Override per-tenant via the boot wiring. Default 'voyage-3-large'
  // unless VOYAGE_API_KEY is missing AND OPENAI_API_KEY is present.
  provider: "voyage-3-large" | "text-embedding-3-large";
  apiKey: string;
  dimension?: number;
}

/**
 * Production factory. Returns null when the SDK package isn't
 * installed; the boot wiring degrades to a no-op embedding pipeline
 * (entries stay with embedding=null, recall falls back to keyword
 * search via M-8's degraded path).
 */
export async function createEmbeddingProvider(
  opts: EmbeddingProviderOpts,
): Promise<EmbeddingProvider | null> {
  if (opts.provider === "voyage-3-large") {
    return createVoyageProvider(opts);
  }
  return createOpenAiProvider(opts);
}

async function createVoyageProvider(
  opts: EmbeddingProviderOpts,
): Promise<EmbeddingProvider | null> {
  // @ts-expect-error optional dep not in package.json
  const mod = await import("voyageai").catch(() => null);
  if (!mod) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Client = (mod as any).VoyageAIClient ?? (mod as any).default?.VoyageAIClient;
  if (!Client) return null;
  const client = new Client({ apiKey: opts.apiKey });
  const dim = opts.dimension ?? 1024;
  return {
    id: "voyage-3-large",
    dimension: dim,
    async embed(texts) {
      return embedInBatches(texts, async (batch) => {
        const res = await client.embed({
          input: batch,
          model: "voyage-3-large",
          outputDimension: dim,
          outputDtype: "float",
        });
        return res.data.map((d: { embedding: number[] }) => Float32Array.from(d.embedding));
      });
    },
  };
}

async function createOpenAiProvider(
  opts: EmbeddingProviderOpts,
): Promise<EmbeddingProvider | null> {
  // @ts-expect-error optional dep not in package.json
  const mod = await import("openai").catch(() => null);
  if (!mod) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Client = (mod as any).default ?? (mod as any).OpenAI;
  if (!Client) return null;
  const client = new Client({ apiKey: opts.apiKey });
  const dim = opts.dimension ?? 1024;
  return {
    id: "text-embedding-3-large",
    dimension: dim,
    async embed(texts) {
      return embedInBatches(texts, async (batch) => {
        const res = await client.embeddings.create({
          model: "text-embedding-3-large",
          input: batch,
          dimensions: dim,
        });
        return res.data.map((d: { embedding: number[] }) => Float32Array.from(d.embedding));
      });
    },
  };
}

async function embedInBatches(
  texts: string[],
  embedFn: (batch: string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (texts.length <= MAX_BATCH) return embedFn(texts);
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const out = await embedFn(batch);
    results.push(...out);
  }
  return results;
}
