import { and, count, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";
import { OutcomeRequiredError, type OutcomeTarget } from "./types.js";

export async function allOutcomesVerified(
  db: any,
  target: OutcomeTarget,
): Promise<true | OutcomeRequiredError> {
  const counts = await db.select({ count: count() }).from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
    eq(outcomes.status, "pending"),
  ));
  if (counts[0].count === 0) return true;

  const pending = await db.select().from(outcomes).where(and(
    eq(outcomes.companyId, target.companyId),
    eq(outcomes.targetKind, target.kind),
    eq(outcomes.targetId, target.id),
    eq(outcomes.status, "pending"),
  ));
  return new OutcomeRequiredError({
    target: { kind: target.kind, id: target.id },
    pending,
  });
}
