// Pure clustering helper for outcome patterns.
//
// Two strategies:
//   - cosine over title embeddings (preferred when an embedding
//     provider is wired up; same provider as Memory's recall path)
//   - Jaccard over tokenized titles (fallback)
//
// The miner produces clusters of size ≥ minClusterSize. Cluster
// identity is the lower-case, sorted token signature of the most
// representative title — re-running the miner re-produces the same
// cluster id rather than spawning duplicates.

export interface RunForCluster {
  runId: string;
  title: string;
  // Optional pre-computed embedding (1024-dim per Memory's schema).
  titleEmbedding?: Float32Array;
}

export interface Cluster {
  signature: string;     // stable id derived from title tokens
  exemplarRunIds: string[];
  representativeTitle: string;
  size: number;
}

export interface ClusterOpts {
  minClusterSize?: number;     // default 3
  embeddingThreshold?: number; // default 0.75 cosine
  jaccardThreshold?: number;   // default 0.4
  maxExemplars?: number;       // default 5
}

const DEFAULT_OPTS: Required<ClusterOpts> = {
  minClusterSize: 3,
  embeddingThreshold: 0.75,
  jaccardThreshold: 0.4,
  maxExemplars: 5,
};

export function clusterRunsByTitle(
  runs: ReadonlyArray<RunForCluster>,
  opts: ClusterOpts = {},
): Cluster[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (runs.length === 0) return [];

  const groups: RunForCluster[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    const seed = runs[i];
    const group: RunForCluster[] = [seed];
    used.add(i);
    for (let j = i + 1; j < runs.length; j++) {
      if (used.has(j)) continue;
      const candidate = runs[j];
      if (similarity(seed, candidate, o) >= 1) {
        group.push(candidate);
        used.add(j);
      }
    }
    if (group.length >= o.minClusterSize) groups.push(group);
  }

  return groups.map((group) => {
    const titles = group.map((g) => g.title);
    const representativeTitle = pickRepresentative(titles);
    return {
      signature: titleSignature(representativeTitle),
      exemplarRunIds: group.slice(0, o.maxExemplars).map((g) => g.runId),
      representativeTitle,
      size: group.length,
    };
  });
}

function similarity(a: RunForCluster, b: RunForCluster, o: Required<ClusterOpts>): number {
  if (a.titleEmbedding && b.titleEmbedding) {
    return cosine(a.titleEmbedding, b.titleEmbedding) >= o.embeddingThreshold ? 1 : 0;
  }
  return jaccard(tokens(a.title), tokens(b.title)) >= o.jaccardThreshold ? 1 : 0;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function titleSignature(title: string): string {
  return [...tokens(title)].sort().join(" ");
}

function pickRepresentative(titles: string[]): string {
  // The shortest title with the most common tokens — a lazy
  // proxy for centrality.
  const counts = new Map<string, number>();
  for (const t of titles) for (const tok of tokens(t)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < titles.length; i++) {
    let score = 0;
    for (const tok of tokens(titles[i])) score += counts.get(tok) ?? 0;
    score = score / Math.max(1, titles[i].length); // bias toward concise
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return titles[bestIdx];
}
