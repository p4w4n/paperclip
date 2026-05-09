// Scheduler glue: per-tick draw loop that walks companies in
// fairness order, dequeues + materializes their next item, and
// resets the rolling fairness counter at the end. Called from
// the existing 30s heartbeat tick (wiring documented as a follow-
// up; for now the heartbeat continues to invoke direct dispatch
// and this entry point is opt-in).
//
// Pattern:
//   1. SELECT companies with state='queued' rows + their credits.
//   2. computeDrawOrder.
//   3. For each company in order, repeatedly call
//      dequeueOneForCompany + materializeWorkItem until either
//      this company has no more items OR the per-tick budget is
//      hit.
//   4. After the loop, UPDATE work_queue_tenant_credits SET
//      recent_dequeued = 0 (rolling reset; the tick itself is
//      the rolling window).
//
// Failure handling: a single materialize() throw is caught + the
// loop continues on the next company. Per-tick errors counter is
// returned for the metrics module.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workItems, workQueueTenantCredits } from "@paperclipai/db";
import { dequeueOneForCompany } from "./dequeue.js";
import { computeDrawOrder, type CompanyFairnessRow } from "./fairness.js";
import { materializeWorkItem } from "./materialize.js";
import { getRoutineMaterializer } from "./routine-integration.js";

export interface RunWorkQueueDrainOpts {
  db: Db;
  // Budget per tick. Default 100 per spec.
  maxItems?: number;
  // The queue name we're draining. Default 'default'.
  queue?: string;
}

export interface DrainResult {
  dequeued: number;
  errors: number;
}

export async function runWorkQueueDrain(opts: RunWorkQueueDrainOpts): Promise<DrainResult> {
  const maxItems = opts.maxItems ?? 100;
  const queue = opts.queue ?? "default";

  // Find companies with queued items + their credit rows. LEFT
  // JOIN so a company with queued items but no credits row gets
  // weight=1 / recent=0 by default.
  const rows = await opts.db.execute<{
    company_id: string;
    weight: number | null;
    recent_dequeued: number | null;
  }>(sql`
    SELECT DISTINCT wi.company_id,
           c.weight,
           c.recent_dequeued
    FROM work_items wi
    LEFT JOIN work_queue_tenant_credits c ON c.company_id = wi.company_id
    WHERE wi.state = 'queued'
      AND wi.queue = ${queue}
      AND wi.available_at <= now()
  `);
  const candidateRows = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{
    company_id: string;
    weight: number | null;
    recent_dequeued: number | null;
  }>;
  if (candidateRows.length === 0) {
    return { dequeued: 0, errors: 0 };
  }

  const fairnessInput: CompanyFairnessRow[] = candidateRows.map((r) => ({
    companyId: r.company_id,
    weight: r.weight ?? 1.0,
    recentDequeued: r.recent_dequeued ?? 0,
  }));
  const order = computeDrawOrder(fairnessInput);

  let dequeued = 0;
  let errors = 0;

  // Round-robin pull: walk the order list cycling through
  // companies until budget is hit or all companies are exhausted.
  const exhausted = new Set<string>();
  while (dequeued < maxItems && exhausted.size < order.length) {
    let madeProgress = false;
    for (const companyId of order) {
      if (dequeued >= maxItems) break;
      if (exhausted.has(companyId)) continue;
      try {
        const item = await dequeueOneForCompany({ db: opts.db, companyId, queue });
        if (!item) {
          exhausted.add(companyId);
          continue;
        }
        await materializeWorkItem(opts.db, {
          item,
          resolveRoutineTarget: item.routineId
            ? (rid, payload) => getRoutineMaterializer()(rid, payload)
            : undefined,
        });
        dequeued++;
        madeProgress = true;
      } catch (err) {
        errors++;
        // eslint-disable-next-line no-console
        console.warn(
          `[work-queue.scheduler] materialize failed for company ${companyId}`,
          err,
        );
        exhausted.add(companyId);
      }
    }
    if (!madeProgress) break;
  }

  // Rolling reset: the tick itself is the window. Companies that
  // weren't drawn this tick get back to credits=weight on the
  // next tick.
  await opts.db.update(workQueueTenantCredits).set({ recentDequeued: 0 });
  // Quiet linter on unused import alias.
  void and;
  void eq;
  void workItems;

  return { dequeued, errors };
}
