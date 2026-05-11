import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";
import { OutcomeRequiredError, type OutcomeTarget } from "./types.js";
import { groupBySlot, isSlotSatisfied } from "./alias-resolver.js";

export async function allOutcomesVerified(
  db: any,
  target: OutcomeTarget,
): Promise<true | OutcomeRequiredError> {
  const rows = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
  ));
  if (rows.length === 0) return true;

  const groups = groupBySlot(rows);
  const blocking: any[] = [];
  for (const [baseName, slotRows] of Object.entries(groups)) {
    if (!isSlotSatisfied(slotRows, baseName)) {
      // Surface the primary row (the one without :alt: suffix) for the error body.
      const primary = slotRows.find((r: any) => r.requiredMeta.name === baseName) ?? slotRows[0];
      blocking.push(primary);
    }
  }
  if (blocking.length === 0) return true;
  return new OutcomeRequiredError({
    target: { kind: target.kind, id: target.id },
    pending: blocking,
  });
}
