import { and, eq } from "drizzle-orm";
import { outcomes } from "@paperclipai/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}

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

  // verified_by_id is a uuid column, but in local_trusted deployment mode the userId is a string
  // slug like "local-board". Only write the FK when it's a real uuid; the canonical user_id
  // string always lives in verified_meta so the audit trail is preserved regardless.
  // (Fix for EO Bug 2: signoff route 500'd with `invalid input syntax for type uuid: "local-board"`.)
  const verifiedByIdUuid = isUuid(input.userId) ? input.userId : null;
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
      verifiedById: verifiedByIdUuid,
      updatedAt: new Date(),
    })
    .where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.status, "pending")))
    .returning();

  return { verifiedCount: result.length };
}
