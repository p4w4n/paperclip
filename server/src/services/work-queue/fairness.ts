// Pure function: weighted round-robin draw order across companies
// for one scheduler tick.
//
// Hatchet's pattern: a per-company `weight` knob (default 1.0)
// dictates the relative dequeue rate; `recent_dequeued` is the
// rolling counter the scheduler resets each tick. Companies with
// `credits = weight - recent_dequeued` are sorted desc; ties are
// broken by lowest `recent_dequeued` so we don't keep pulling
// from the same company within a tick.

export interface CompanyFairnessRow {
  companyId: string;
  weight: number;
  recentDequeued: number;
}

export function computeDrawOrder(rows: CompanyFairnessRow[]): string[] {
  const sorted = rows.slice().sort((a, b) => {
    const creditsA = a.weight - a.recentDequeued;
    const creditsB = b.weight - b.recentDequeued;
    if (creditsB !== creditsA) return creditsB - creditsA;
    if (a.recentDequeued !== b.recentDequeued) return a.recentDequeued - b.recentDequeued;
    return a.companyId.localeCompare(b.companyId);
  });
  return sorted.map((r) => r.companyId);
}
