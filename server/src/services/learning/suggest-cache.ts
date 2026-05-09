// In-memory LRU cache for suggestPlaybooks. The hot path runs
// once per run-start, so even small cache hits add up across a
// busy fleet. Cache key: (companyId, content-hash of issueContext).
// TTL: 60s. Size: 1000 entries.
//
// Admin curation (approve / archive / promote) invalidates the
// cache; explicit invalidate() lives at the boot wiring.

import { createHash } from "node:crypto";
import type { IssueContext, SuggestionResult } from "./types.js";

interface Entry {
  value: SuggestionResult[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

export class SuggestCache {
  private map = new Map<string, Entry>();
  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  get(companyId: string, ctx: IssueContext): SuggestionResult[] | null {
    const key = makeKey(companyId, ctx);
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // LRU touch: re-insert to move to the end.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(companyId: string, ctx: IssueContext, value: SuggestionResult[]): void {
    const key = makeKey(companyId, ctx);
    if (this.map.size >= this.maxEntries) {
      // Evict the oldest (first inserted).
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidateCompany(companyId: string): void {
    const prefix = `${companyId}::`;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

function makeKey(companyId: string, ctx: IssueContext): string {
  const normalized = JSON.stringify({
    title: ctx.title,
    labels: [...ctx.labels].sort(),
    projectId: ctx.projectId ?? null,
    assigneeAgentId: ctx.assigneeAgentId ?? null,
  });
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${companyId}::${digest}`;
}

// Module-global default — boot wiring instantiates one and the
// admin REST handlers call invalidateCompany when state mutates.
let singleton: SuggestCache | null = null;
export function initializeSuggestCache(opts?: {
  ttlMs?: number;
  maxEntries?: number;
}): SuggestCache {
  singleton = new SuggestCache(opts?.ttlMs, opts?.maxEntries);
  return singleton;
}
export function getSuggestCache(): SuggestCache | null {
  return singleton;
}
