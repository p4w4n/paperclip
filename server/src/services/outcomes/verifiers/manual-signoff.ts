import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

export interface ManualSignoffInput {
  outcomeId: string;
  companyId: string;
  userId: string;
  userRole: string | null;
  note?: string;
}

export class SignoffRoleMismatchError extends Error {
  statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "SignoffRoleMismatchError";
  }
}

export async function verifyManualSignoff(
  db: any,
  input: ManualSignoffInput,
): Promise<{ verifiedCount: number }> {
  const rows = await db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.id, input.outcomeId),
        eq(outcomes.companyId, input.companyId),
        eq(outcomes.kind, "manual_signoff"),
        eq(outcomes.status, "pending"),
      ),
    );

  if (rows.length === 0) return { verifiedCount: 0 };

  const row = rows[0];
  const requiredRole: string | undefined = row.requiredMeta?.required_role;
  if (requiredRole && requiredRole !== input.userRole) {
    throw new SignoffRoleMismatchError(`signoff requires role: ${requiredRole}`);
  }

  const result = await db
    .update(outcomes)
    .set({
      status: "verified",
      verifiedMeta: {
        user_id: input.userId,
        signed_at: new Date().toISOString(),
        note: input.note ?? null,
      },
      verifiedAt: new Date(),
      verifiedByKind: "user",
      verifiedById: input.userId,
      updatedAt: new Date(),
    })
    .where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.status, "pending")))
    .returning();

  return { verifiedCount: result.length };
}
