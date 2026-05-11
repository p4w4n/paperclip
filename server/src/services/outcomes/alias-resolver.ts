// Pure helpers for outcome alias (OR-of-outcomes) materialization + resolution.
// Single-level OR only; nested groups deferred to Plan 3.

import type { ContractEntry } from "./contract.js";

interface OutcomeRowLike {
  kind: string;
  requiredMeta: { name: string; [k: string]: unknown };
  status: string;
}

const ALT_SUFFIX_RE = /:alt:\d+$/;

export function baseNameOf(name: string): string {
  return name.replace(ALT_SUFFIX_RE, "");
}

export function isSlotSatisfied(rows: OutcomeRowLike[], slotBaseName: string): boolean {
  return rows.some(
    (r) => r.status === "verified" && baseNameOf(r.requiredMeta.name) === slotBaseName,
  );
}

export function groupBySlot(rows: OutcomeRowLike[]): Record<string, OutcomeRowLike[]> {
  const out: Record<string, OutcomeRowLike[]> = {};
  for (const r of rows) {
    const base = baseNameOf(r.requiredMeta.name);
    (out[base] ??= []).push(r);
  }
  return out;
}

// Project one contract entry into N+1 outcome rows (1 primary + N alternatives).
// The primary keeps its requiredMeta as-is; alternatives get `:alt:N` name suffix.
export function expandContractEntryToRows(
  entry: ContractEntry & { alternatives?: Array<{ kind: string; requiredMeta: Record<string, unknown> }> },
): Array<{ kind: string; requiredMeta: Record<string, unknown> }> {
  const primaryName = (entry.requiredMeta as { name?: string }).name ?? "";
  const primary = {
    kind: entry.kind,
    requiredMeta: { ...entry.requiredMeta, name: primaryName },
  };
  const alts = (entry.alternatives ?? []).map((alt, idx: number) => ({
    kind: alt.kind,
    requiredMeta: { ...alt.requiredMeta, name: `${primaryName}:alt:${idx}` },
  }));
  return [primary, ...alts];
}
