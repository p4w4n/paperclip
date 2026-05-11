// Pure merger for playbook-suggested outcomes.
// Identity key for a contract entry is (kind, requiredMeta.name).

import type { ContractEntry } from "./contract.js";

export type MergeStrategy = "skip_existing" | "replace";

export interface MergeResult {
  merged: ContractEntry[];
  added: Array<{ kind: string; name: string }>;
  skippedExisting: Array<{ kind: string; name: string }>;
}

function keyOf(entry: ContractEntry): string {
  const name = (entry.requiredMeta as { name?: string })?.name ?? "";
  return `${entry.kind}::${name}`;
}

function nameOf(entry: ContractEntry): string {
  return (entry.requiredMeta as { name?: string })?.name ?? "";
}

export function mergeSuggestedOutcomes(
  existing: ContractEntry[],
  suggested: ContractEntry[],
  strategy: MergeStrategy,
): MergeResult {
  if (strategy === "replace") {
    return {
      merged: suggested,
      added: suggested.map((e) => ({ kind: e.kind, name: nameOf(e) })),
      skippedExisting: [],
    };
  }

  const existingKeys = new Set(existing.map(keyOf));
  const added: Array<{ kind: string; name: string }> = [];
  const skippedExisting: Array<{ kind: string; name: string }> = [];
  const toAppend: ContractEntry[] = [];

  for (const entry of suggested) {
    if (existingKeys.has(keyOf(entry))) {
      skippedExisting.push({ kind: entry.kind, name: nameOf(entry) });
    } else {
      added.push({ kind: entry.kind, name: nameOf(entry) });
      toAppend.push(entry);
    }
  }

  return { merged: [...existing, ...toAppend], added, skippedExisting };
}
