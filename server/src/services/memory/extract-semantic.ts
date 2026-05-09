// Promotion stage: episodic → semantic. Karpathy's three-layer
// model treats raw run-event entries as the "raw" tier; semantic
// distillation pulls durable facts out of clusters of episodics.
//
// Flow:
//   1. Pick a batch of recently-created episodics that haven't been
//      processed yet (we mark them via the supersedes_id chain — a
//      semantic fact derived from an episodic is linked back).
//   2. Ask the LLM to extract durable facts: stable preferences,
//      conventions, patterns. Hallucinations are the main risk;
//      the prompt is conservative ("if you're not sure, omit it").
//   3. Write the extracted semantic facts as new entries with
//      supersedes_id pointing back to the source episodic — that
//      provenance is what makes them inspectable later.
//
// The LLM call is injected via LlmClient; tests pass a mock.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries } from "@paperclipai/db";
import type { LlmClient } from "./types.js";

export interface ExtractSemanticOpts {
  db: Db;
  llm: LlmClient;
  // How many episodics to consider per tick. Default 50.
  batchSize?: number;
  // Skip episodics newer than this (lets the buffer settle so we
  // promote on stable patterns, not transient ones). Default 5min.
  ageMinFloorMs?: number;
}

const SYSTEM_PROMPT = `You extract durable, agent-useful facts from episodic events.

A "durable fact" is a preference, convention, decision, or pattern that
is likely to remain true across sessions. NOT a one-off action, NOT a
specific tool call, NOT a transient state.

Output format: JSON array of objects, each {"content": "...", "kind": "semantic"|"procedural"}.
- "semantic" = stable factual claim ("the user prefers conventional commits")
- "procedural" = stable how-to ("when running migrations, always run the smoke suite first")

If no durable facts are present, return [].
Be conservative. When in doubt, omit.`;

export interface ExtractedFact {
  content: string;
  kind: "semantic" | "procedural";
}

export function buildExtractionUserPrompt(
  episodics: Array<{ content: string }>,
): string {
  return [
    "Extract durable facts from these run events:",
    "",
    ...episodics.map((e, i) => `${i + 1}. ${e.content}`),
  ].join("\n");
}

export function parseExtractionResponse(raw: string): ExtractedFact[] {
  // Tolerate prose before/after the JSON; locate the first array.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    const out: ExtractedFact[] = [];
    for (const item of arr) {
      if (
        item &&
        typeof item.content === "string" &&
        (item.kind === "semantic" || item.kind === "procedural")
      ) {
        out.push({ content: item.content, kind: item.kind });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface SemanticExtractionResult {
  episodicsConsidered: number;
  factsExtracted: number;
  errors: number;
}

export async function extractSemanticTick(
  opts: ExtractSemanticOpts,
): Promise<SemanticExtractionResult> {
  const batchSize = opts.batchSize ?? 50;
  const ageFloorMs = opts.ageMinFloorMs ?? 5 * 60_000;
  const cutoff = new Date(Date.now() - ageFloorMs);

  const episodics = await opts.db
    .select({
      id: memoryEntries.id,
      companyId: memoryEntries.companyId,
      userId: memoryEntries.userId,
      agentId: memoryEntries.agentId,
      sessionId: memoryEntries.sessionId,
      sessionKind: memoryEntries.sessionKind,
      content: memoryEntries.content,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.kind, "episodic"),
        isNull(memoryEntries.supersededAt),
        sql`${memoryEntries.createdAt} < ${cutoff}`,
        // Hasn't already produced a derivative
        sql`NOT EXISTS (SELECT 1 FROM memory_entries d WHERE d.supersedes_id = ${memoryEntries.id})`,
      ),
    )
    .orderBy(desc(memoryEntries.createdAt))
    .limit(batchSize);

  if (episodics.length === 0) {
    return { episodicsConsidered: 0, factsExtracted: 0, errors: 0 };
  }

  let factsExtracted = 0;
  let errors = 0;

  // Group by company (semantic facts inherit scope from their
  // sources; mixing companies into one LLM call would leak tenant
  // data even if the prompt says don't).
  const byCompany = new Map<string, typeof episodics>();
  for (const e of episodics) {
    const list = byCompany.get(e.companyId) ?? [];
    list.push(e);
    byCompany.set(e.companyId, list);
  }

  for (const [, group] of byCompany) {
    try {
      const raw = await opts.llm.generate({
        system: SYSTEM_PROMPT,
        user: buildExtractionUserPrompt(group),
      });
      const extracted = parseExtractionResponse(raw);
      if (extracted.length === 0) continue;

      // Inherit scope from the first source episodic — semantics
      // are usually about the broader scope (company / agent), not
      // a specific session, so we strip session_id by default.
      const source = group[0];
      for (const fact of extracted) {
        await opts.db.insert(memoryEntries).values({
          companyId: source.companyId,
          userId: source.userId,
          agentId: source.agentId,
          sessionId: null,
          sessionKind: null,
          kind: fact.kind,
          content: fact.content,
          supersedesId: source.id,
          salience: 0.6, // promoted facts start above default 0.5
        });
        factsExtracted++;
      }
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.warn("[memory.extract-semantic] LLM call failed", err);
    }
  }

  return {
    episodicsConsidered: episodics.length,
    factsExtracted,
    errors,
  };
}
