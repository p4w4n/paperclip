import { baseNameOf } from "./alias-resolver.js";

interface OutcomeRowLike {
  kind: string;
  requiredMeta: { name: string; auto_reopen_on_revert?: boolean; [k: string]: unknown };
  status: string;
}

export type ReopenDecision =
  | { reopen: true }
  | { reopen: false; reason?: "alt_covers" | "flag_false" };

export function shouldReopenParent(
  reverted: OutcomeRowLike,
  siblings: OutcomeRowLike[],
): ReopenDecision {
  if (reverted.requiredMeta.auto_reopen_on_revert !== true) {
    return { reopen: false, reason: "flag_false" };
  }
  const base = baseNameOf(reverted.requiredMeta.name);
  const altCovers = siblings.some(
    (s) => s.status === "verified" && baseNameOf(s.requiredMeta.name) === base,
  );
  if (altCovers) return { reopen: false, reason: "alt_covers" };
  return { reopen: true };
}
