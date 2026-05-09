// Ingest stage: semantic facts → wiki pages. Karpathy's third tier
// is the curated wiki — distinct from the noisy episodic + semantic
// row store. Pages are written by the LLM after looking at clusters
// of facts on a topic, and are the layer the agent treats as
// authoritative.
//
// Heuristic clustering: group facts by (companyId, agentId) and let
// the LLM cluster topically within each group. Embedding-based
// agglomeration is a Plan 2 follow-up; the LLM-clustering approach
// is good enough at small N (the prompt sees ~50 facts and decides
// what belongs together).
//
// Side-effect: each fact whose id appears in a page's
// source_entry_ids is considered "ingested" and won't be picked up
// by the next tick. We don't supersede the source facts; they stay
// queryable in their own scope and the page references them.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries } from "@paperclipai/db";
import type { LlmClient, MemoryScope, WikiBackend } from "./types.js";

export interface IngestPageOpts {
  db: Db;
  llm: LlmClient;
  wiki: WikiBackend;
  // How many facts to consider per tick. Default 100.
  batchSize?: number;
  // Min cluster size; smaller clusters wait until they grow.
  minClusterSize?: number;
}

const SYSTEM_PROMPT = `You curate a wiki from a stream of agent-extracted facts.

Group related facts into wiki pages. Each page should:
- Cover ONE topic.
- Cite source fact ids in sourceFactIds.
- Have a slug (kebab-case, ascii lowercase).
- Have a title (Title Case, < 60 chars).
- Have markdown content. Reference other pages with [[slug]] when natural.

Output: JSON object {"pages": [{"slug": "...", "title": "...", "sourceFactIds": [...], "content": "...", "links": ["other-slug", ...]}]}.

Constraints:
- Don't invent facts. Use only what's in the input.
- Skip clusters with fewer than 2 facts.
- If the input is too noisy to cluster cleanly, return {"pages": []}.`;

export interface DraftedPage {
  slug: string;
  title: string;
  sourceFactIds: string[];
  content: string;
  links: string[];
}

export function buildClusterUserPrompt(
  facts: Array<{ id: string; content: string; kind: string }>,
): string {
  const lines = ["Cluster these facts into wiki pages:", ""];
  for (const f of facts) {
    lines.push(`- (${f.id}) [${f.kind}] ${f.content}`);
  }
  return lines.join("\n");
}

export function parseClusterResponse(raw: string): DraftedPage[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || !Array.isArray(parsed.pages)) return [];
    const out: DraftedPage[] = [];
    for (const p of parsed.pages) {
      if (
        typeof p?.slug === "string" &&
        typeof p?.title === "string" &&
        typeof p?.content === "string" &&
        Array.isArray(p?.sourceFactIds) &&
        p.sourceFactIds.every((s: unknown) => typeof s === "string")
      ) {
        out.push({
          slug: p.slug,
          title: p.title,
          content: p.content,
          sourceFactIds: p.sourceFactIds,
          links: Array.isArray(p.links) ? p.links.filter((s: unknown) => typeof s === "string") : [],
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface IngestResult {
  factsConsidered: number;
  pagesWritten: number;
  errors: number;
}

export async function ingestPageTick(opts: IngestPageOpts): Promise<IngestResult> {
  const batchSize = opts.batchSize ?? 100;
  const minCluster = opts.minClusterSize ?? 2;

  // Pick semantic + procedural facts not yet referenced by any page.
  const facts = await opts.db
    .select({
      id: memoryEntries.id,
      companyId: memoryEntries.companyId,
      agentId: memoryEntries.agentId,
      userId: memoryEntries.userId,
      content: memoryEntries.content,
      kind: memoryEntries.kind,
    })
    .from(memoryEntries)
    .where(
      and(
        sql`${memoryEntries.kind} IN ('semantic','procedural')`,
        isNull(memoryEntries.supersededAt),
        sql`NOT EXISTS (
          SELECT 1 FROM memory_pages p
          WHERE p.superseded_at IS NULL
            AND ${memoryEntries.id} = ANY(p.source_entry_ids)
        )`,
      ),
    )
    .orderBy(desc(memoryEntries.createdAt))
    .limit(batchSize);

  if (facts.length < minCluster) {
    return { factsConsidered: facts.length, pagesWritten: 0, errors: 0 };
  }

  // Group by (companyId, agentId) — agent-scoped wikis are the
  // primary granularity per the spec. company-scope pages are
  // produced when agentId is null on every fact in the group.
  type Group = { companyId: string; agentId: string | null; facts: typeof facts };
  const groups = new Map<string, Group>();
  for (const f of facts) {
    const key = `${f.companyId}::${f.agentId ?? "_"}`;
    const g = groups.get(key) ?? { companyId: f.companyId, agentId: f.agentId, facts: [] };
    g.facts.push(f);
    groups.set(key, g);
  }

  let pagesWritten = 0;
  let errors = 0;

  for (const [, group] of groups) {
    if (group.facts.length < minCluster) continue;
    try {
      const raw = await opts.llm.generate({
        system: SYSTEM_PROMPT,
        user: buildClusterUserPrompt(group.facts),
      });
      const drafted = parseClusterResponse(raw);
      const factIds = new Set(group.facts.map((f) => f.id));
      const scope: MemoryScope = { companyId: group.companyId, agentId: group.agentId ?? undefined };
      for (const draft of drafted) {
        // Filter sourceFactIds to ones that actually appeared in
        // the input — defends against the LLM hallucinating ids.
        const sourceIds = draft.sourceFactIds.filter((id) => factIds.has(id));
        if (sourceIds.length < minCluster) continue;
        try {
          await opts.wiki.upsertPage({
            scope,
            slug: draft.slug,
            title: draft.title,
            contentMarkdown: draft.content,
            sourceEntryIds: sourceIds,
            links: draft.links.map((slug) => ({ slug })),
          });
          pagesWritten++;
        } catch (err) {
          errors++;
          // eslint-disable-next-line no-console
          console.warn("[memory.ingest-page] upsert failed", err);
        }
      }
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.warn("[memory.ingest-page] LLM cluster call failed", err);
    }
  }

  return { factsConsidered: facts.length, pagesWritten, errors };
}
