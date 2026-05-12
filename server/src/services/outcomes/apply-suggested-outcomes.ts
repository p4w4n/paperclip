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
    // Partition suggested against existing by (kind, name). Net-new entries go
    // to `added`; entries that already existed go to `skippedExisting` (field
    // name reused for response back-compat — semantically "replacedExisting").
    const existingKeys = new Set(existing.map(keyOf));
    const added: Array<{ kind: string; name: string }> = [];
    const replacedExisting: Array<{ kind: string; name: string }> = [];
    for (const entry of suggested) {
      if (existingKeys.has(keyOf(entry))) {
        replacedExisting.push({ kind: entry.kind, name: nameOf(entry) });
      } else {
        added.push({ kind: entry.kind, name: nameOf(entry) });
      }
    }
    return {
      merged: suggested,
      added,
      skippedExisting: replacedExisting, // "replacedExisting" — kept for response back-compat
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
