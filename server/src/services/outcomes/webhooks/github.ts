import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companies, githubWebhookDeliveries, issues, outcomes } from "@paperclipai/db";
import { verifyHmacSignature } from "../hmac.js";
import { parseGithubPrEvent, extractIssueIdentifier } from "./github-payload-parser.js";
import { ingestExternalSignal } from "../verifiers/external-signal.js";

export class GitHubWebhookSecretNotConfiguredError extends Error {
  statusCode = 404;
  constructor(companyId: string) {
    super(`No github_webhook_secret for company ${companyId}`);
    this.name = "GitHubWebhookSecretNotConfiguredError";
  }
}

export interface IngestInput {
  companyId: string;
  deliveryId: string;
  eventType: string;
  signature: string;
  rawBody: string;
}

export async function ingestGithubWebhook(
  db: any,
  input: IngestInput,
): Promise<{ verified: boolean; matchedOutcomes: string[]; result: string; replay?: boolean }> {
  // 1. Lookup company secret + issue prefix
  const [co] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId));

  if (!co?.githubWebhookSecret) throw new GitHubWebhookSecretNotConfiguredError(input.companyId);

  // 2. Verify HMAC
  const sigOk = verifyHmacSignature({
    secret: co.githubWebhookSecret,
    rawBody: input.rawBody,
    providedSig: input.signature,
  });
  const rawBodySha256 = createHash("sha256").update(input.rawBody).digest("hex");

  // 3. Replay dedup
  const [existing] = await db
    .select()
    .from(githubWebhookDeliveries)
    .where(
      and(
        eq(githubWebhookDeliveries.companyId, input.companyId),
        eq(githubWebhookDeliveries.deliveryId, input.deliveryId),
      ),
    );

  if (existing) {
    return {
      verified: existing.result === "verified",
      matchedOutcomes: existing.outcomeId ? [existing.outcomeId] : [],
      result: existing.result,
      replay: true,
    };
  }

  if (!sigOk) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: null,
      prUrl: null,
      outcomeId: null,
      signatureValid: false,
      result: "invalid_signature",
      rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "invalid_signature" };
  }

  // 4. Parse + filter
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    payload = {};
  }
  const parsed = parseGithubPrEvent(payload);

  if (parsed.kind !== "merged") {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: (payload as any)?.action ?? null,
      prUrl: null,
      outcomeId: null,
      signatureValid: true,
      result: "ignored",
      rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "ignored" };
  }

  // 5. Resolve issue
  const identifier = extractIssueIdentifier(payload, co.issuePrefix ?? "PAP");
  if (!identifier) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: (payload as any).action,
      prUrl: parsed.prUrl,
      outcomeId: null,
      signatureValid: true,
      result: "no_match",
      rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "no_match" };
  }

  const [issue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.identifier, identifier)));

  if (!issue) {
    await db.insert(githubWebhookDeliveries).values({
      companyId: input.companyId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action: (payload as any).action,
      prUrl: parsed.prUrl,
      outcomeId: null,
      signatureValid: true,
      result: "no_match",
      rawBodySha256,
    });
    return { verified: false, matchedOutcomes: [], result: "no_match" };
  }

  // 6. Match pending external_signal outcomes
  const pending = await db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.companyId, input.companyId),
        eq(outcomes.targetKind, "issue"),
        eq(outcomes.targetId, issue.id),
        eq(outcomes.kind, "external_signal"),
        eq(outcomes.status, "pending"),
      ),
    );

  const matched = (pending as any[]).filter((o: any) => {
    const src = (o.requiredMeta?.source ?? "").toLowerCase();
    return src === "github" || src.startsWith("github");
  });

  const matchedOutcomes: string[] = [];
  for (const m of matched) {
    const r = await ingestExternalSignal(db, {
      outcomeId: m.id,
      companyId: input.companyId,
      rawBody: input.rawBody,
      signature: input.signature,
      idempotencyKey: input.deliveryId,
      skipHmacVerify: true, // GitHub adapter already verified above against github_webhook_secret
    });
    if (r.verified) matchedOutcomes.push(m.id);
  }

  await db.insert(githubWebhookDeliveries).values({
    companyId: input.companyId,
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    action: (payload as any).action,
    prUrl: parsed.prUrl,
    outcomeId: matchedOutcomes[0] ?? null,
    signatureValid: true,
    result: matchedOutcomes.length > 0 ? "verified" : "no_match",
    rawBodySha256,
  });

  return {
    verified: matchedOutcomes.length > 0,
    matchedOutcomes,
    result: matchedOutcomes.length > 0 ? "verified" : "no_match",
  };
}
