import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { outcomes, companies } from "@paperclipai/db";
import { verifyHmacSignature } from "../hmac.js";

export class SignalAuthError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "SignalAuthError";
  }
}

export class SignalReplayMismatchError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "SignalReplayMismatchError";
  }
}

export interface SignalIngestInput {
  outcomeId: string;
  companyId: string;
  rawBody: string;
  signature: string;
  idempotencyKey: string;
  /**
   * EO-P2-14: When true, skip the HMAC verification step. The CALLER must
   * have verified the signature against the appropriate per-integration
   * secret (e.g., GitHub adapter verifies against `companies.github_webhook_secret`
   * before delegating). Used to compose webhook adapters on top of the
   * generic external_signal verifier without forcing them to share a secret.
   */
  skipHmacVerify?: boolean;
}

export async function ingestExternalSignal(
  db: any,
  input: SignalIngestInput,
): Promise<{ verified: boolean; replay: boolean }> {
  if (!input.skipHmacVerify) {
    const cos = await db
      .select()
      .from(companies)
      .where(eq(companies.id, input.companyId));

    const secret = cos[0]?.outcomeSignalSecret;
    if (!secret) throw new SignalAuthError("signal secret not provisioned");

    if (
      !verifyHmacSignature({
        secret,
        rawBody: input.rawBody,
        providedSig: input.signature,
      })
    ) {
      throw new SignalAuthError("hmac mismatch");
    }
  }

  const rows = await db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.id, input.outcomeId),
        eq(outcomes.companyId, input.companyId),
        eq(outcomes.kind, "external_signal"),
      ),
    );

  if (rows.length === 0) throw new SignalAuthError("outcome not found");

  const row = rows[0];

  // Idempotency replay handling on already-verified outcomes.
  if (row.status === "verified") {
    if (row.verifiedMeta?.idempotency_key === input.idempotencyKey) {
      const sameBody =
        row.verifiedMeta?.payload_sha256 === sha256Hex(input.rawBody);
      if (!sameBody) {
        throw new SignalReplayMismatchError(
          "idempotency key conflict (different body)",
        );
      }
      return { verified: true, replay: true };
    }
    // Already verified by an earlier signal with a different key — accept idempotently.
    return { verified: true, replay: false };
  }

  const result = await db
    .update(outcomes)
    .set({
      status: "verified",
      verifiedMeta: {
        idempotency_key: input.idempotencyKey,
        signature_verified: true,
        payload_sha256: sha256Hex(input.rawBody),
        received_at: new Date().toISOString(),
      },
      verifiedAt: new Date(),
      verifiedByKind: "webhook",
      updatedAt: new Date(),
    })
    .where(and(eq(outcomes.id, row.id), eq(outcomes.status, "pending")))
    .returning();

  return { verified: result.length > 0, replay: false };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
