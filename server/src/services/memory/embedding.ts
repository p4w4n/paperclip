// Embedding provider abstraction. Three options:
//   - voyage-3-large: MTEB 2026 leader at retrieval; ~10% better
//     than text-embedding-3-large per voyage's benchmark.
//   - text-embedding-3-large: OpenAI default.
//   - ollama: free + local. User runs an Ollama daemon and pulls
//     a 1024-dim embedding model (`ollama pull bge-m3` or
//     `ollama pull mxbai-embed-large`). No API key. No SDK.
//     Default base URL http://127.0.0.1:11434.
//
// Voyage / OpenAI SDKs are lazy-imported — unit tests that don't
// exercise the production providers don't pay the load cost. The
// ollama provider has zero dependencies — pure fetch().
//
// Default dimension is 1024 (matches the schema's vector(1024)). For
// providers that emit 3072-dim by default (text-embedding-3-large at
// full size), we configure them to truncate to 1024 — the spec's
// int8 quantization recommendation lands as a follow-up in Plan 2.

const MAX_BATCH = 100;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "bge-m3";

export type EmbeddingProviderId =
  | "voyage-3-large"
  | "text-embedding-3-large"
  | "ollama";

export interface EmbeddingProvider {
  id: EmbeddingProviderId;
  dimension: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingProviderOpts {
  provider: EmbeddingProviderId;
  // Required for voyage / openai. Unused for ollama.
  apiKey?: string;
  dimension?: number;
  // Ollama-only.
  baseUrl?: string;
  model?: string;
}

/**
 * Production factory. Returns null when the underlying provider isn't
 * available (missing SDK package, ollama not reachable); the boot
 * wiring degrades to a no-op embedding pipeline (entries stay with
 * embedding=null, recall falls back to keyword search).
 */
export async function createEmbeddingProvider(
  opts: EmbeddingProviderOpts,
): Promise<EmbeddingProvider | null> {
  if (opts.provider === "voyage-3-large") {
    return createVoyageProvider(opts);
  }
  if (opts.provider === "text-embedding-3-large") {
    return createOpenAiProvider(opts);
  }
  return createOllamaProvider(opts);
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

async function createOllamaProvider(
  opts: EmbeddingProviderOpts,
): Promise<EmbeddingProvider | null> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_OLLAMA_MODEL;

  // Probe once at factory time so a misconfigured base URL surfaces
  // at boot rather than on the first recall. We only check the
  // model exists; we don't pre-warm it.
  let detectedDimension: number | null = opts.dimension ?? null;
  try {
    const probe = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: ["probe"] }),
    });
    if (!probe.ok) return null;
    const json = (await probe.json()) as { embeddings?: number[][] };
    const first = json.embeddings?.[0];
    if (!Array.isArray(first) || first.length === 0) return null;
    detectedDimension = detectedDimension ?? first.length;
    // Schema is vector(1024). If the model emits a different
    // dimension, refuse to bind: writes would crash and silently
    // accepting wrong dimensions corrupts recall.
    if (detectedDimension !== 1024) {
      // eslint-disable-next-line no-console
      console.warn(
        `[memory.embedding.ollama] model ${model} emits ${detectedDimension}-dim vectors but schema requires 1024; refusing to bind. Use bge-m3 or mxbai-embed-large.`,
      );
      return null;
    }
  } catch {
    // Daemon not reachable — return null so the worker stays idle.
    return null;
  }

  return {
    id: "ollama",
    dimension: detectedDimension!,
    async embed(texts) {
      return embedInBatches(texts, async (batch) => {
        const res = await fetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: batch }),
        });
        if (!res.ok) {
          throw new Error(`ollama /api/embed ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as { embeddings?: number[][] };
        if (!Array.isArray(json.embeddings)) {
          throw new Error("ollama /api/embed: missing embeddings array");
        }
        return json.embeddings.map((v) => Float32Array.from(v));
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
