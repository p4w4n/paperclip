// Pure contract-diff helper for OutcomesService.materializeContract.
// Computes insert / keep / delete partitions when a contract on an issue or plan changes.

export type ContractEntry = { kind: string; requiredMeta: { name: string; [k: string]: unknown } };
export type ExistingRow = { id: string; kind: string; requiredMeta: { name: string }; status: string };

export interface DiffResult {
  toInsert: ContractEntry[];
  toKeep: ExistingRow[];
  pendingToDelete: ExistingRow[];
  droppedVerified: ExistingRow[];
}

export function diffContract(existing: ExistingRow[], desired: ContractEntry[]): DiffResult {
  const key = (x: { kind: string; requiredMeta: { name: string } }) => `${x.kind}::${x.requiredMeta.name}`;
  const desiredKeys = new Set(desired.map(key));
  const existingKeys = new Set(existing.map(key));

  const toInsert = desired.filter((d) => !existingKeys.has(key(d)));
  const toKeep = existing.filter((e) => desiredKeys.has(key(e)));
  const dropped = existing.filter((e) => !desiredKeys.has(key(e)));
  const pendingToDelete = dropped.filter((e) => e.status === "pending");
  const droppedVerified = dropped.filter((e) => e.status === "verified");

  return { toInsert, toKeep, pendingToDelete, droppedVerified };
}
