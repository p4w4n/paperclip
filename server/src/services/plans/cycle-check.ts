// Pure DAG cycle detector. Used before inserting a new edge into
// plan_phase_dependencies — Postgres can't enforce DAG-ness with a
// constraint, so the service-layer check is the gate.
//
// Approach: given the existing edges + the proposed (from, to)
// edge, walk the existing edges from `to` outwards via DFS. If we
// reach `from`, the new edge would close a cycle.

export interface DepEdge {
  fromPhaseId: string;
  toPhaseId: string;
}

/**
 * Returns true if adding (from, to) to existingEdges would create
 * a cycle. Self-loops (from === to) are always rejected.
 */
export function wouldCreateCycle(
  existingEdges: ReadonlyArray<DepEdge>,
  newEdge: DepEdge,
): boolean {
  if (newEdge.fromPhaseId === newEdge.toPhaseId) return true;

  // Build forward adjacency from existing edges.
  const adj = new Map<string, string[]>();
  for (const e of existingEdges) {
    const list = adj.get(e.fromPhaseId) ?? [];
    list.push(e.toPhaseId);
    adj.set(e.fromPhaseId, list);
  }

  // DFS from newEdge.to following existing edges; if we reach
  // newEdge.from, the new edge closes a cycle.
  const stack: string[] = [newEdge.toPhaseId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === newEdge.fromPhaseId) return true;
    const next = adj.get(node);
    if (next) stack.push(...next);
  }
  return false;
}
