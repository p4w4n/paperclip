// Pattern miner production tick. Runs alongside the memory
// reflection worker (Plan 1 of Memory M-12). Per company:
//
//   1. Pull recently-completed runs (default: past 24h, status
//      'succeeded' or 'failed').
//   2. Cluster via the pure clusterRunsByTitle helper.
//   3. For each cluster, hash a stable signature; if an
//      outcome_pattern row already exists with that signature,
//      extend its exemplar_run_ids + cluster_size + bump confidence.
//      Otherwise insert a new row at confidence = min(0.9, size/10).
//
// LLM synthesis of pattern_name + pattern_description happens here
// when an LlmClient is wired up; otherwise we fall back to
// representativeTitle as the name.

import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, outcomePatterns } from "@paperclipai/db";
import { clusterRunsByTitle, type RunForCluster } from "./pattern-miner.js";

export interface PatternMinerTickOpts {
  db: Db;
  llm?: { generate(input: { system: string; user: string }): Promise<string> };
  // Window for "recent" runs. Default 24h.
  windowHours?: number;
  // Per-tick LLM call budget (default 10).
  maxLlmCalls?: number;
  // Min cluster size; default 3.
  minClusterSize?: number;
  // Override "now" — tests use it.
  now?: Date;
}

export interface PatternMinerTickResult {
  clustersFound: number;
  rowsInserted: number;
  rowsUpdated: number;
  errors: number;
}

const SYSTEM_PROMPT = `You name + describe a cluster of similar agent runs.

Input: a list of run titles. Output STRICT JSON:
  {"name": "<short noun phrase, < 60 chars>", "description": "<one-sentence summary>"}

Be concrete. Avoid generic words like "issue" or "task".`;

interface RecentRun {
  id: string;
  // We pull title from contextSnapshot.issueTitle (set by heartbeat).
  contextSnapshot: Record<string, unknown> | null;
  companyId: string;
}

export async function patternMinerTick(
  opts: PatternMinerTickOpts,
): Promise<PatternMinerTickResult> {
  const now = opts.now ?? new Date();
  const windowMs = (opts.windowHours ?? 24) * 60 * 60 * 1000;
  const since = new Date(now.getTime() - windowMs);
  const minClusterSize = opts.minClusterSize ?? 3;
  const maxLlmCalls = opts.maxLlmCalls ?? 10;

  // Pull recently-completed runs across all companies. The reflection
  // worker shape is per-tenant in concept; in practice the DB
  // partitions on company_id and the per-cluster work doesn't cross.
  const recent = (await opts.db
    .select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      companyId: heartbeatRuns.companyId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        gt(heartbeatRuns.finishedAt, since),
        sql`${heartbeatRuns.status} IN ('succeeded','failed')`,
      ),
    )
    .limit(2000)) as RecentRun[];

  if (recent.length === 0) {
    return { clustersFound: 0, rowsInserted: 0, rowsUpdated: 0, errors: 0 };
  }

  // Group by company.
  const byCompany = new Map<string, RecentRun[]>();
  for (const r of recent) {
    const list = byCompany.get(r.companyId) ?? [];
    list.push(r);
    byCompany.set(r.companyId, list);
  }

  let clustersFound = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let errors = 0;
  let llmCallsRemaining = maxLlmCalls;

  for (const [companyId, runs] of byCompany) {
    const forCluster: RunForCluster[] = runs
      .map((r) => ({
        runId: r.id,
        title: readTitle(r.contextSnapshot),
      }))
      .filter((r) => r.title.length > 0);

    const clusters = clusterRunsByTitle(forCluster, { minClusterSize });
    clustersFound += clusters.length;

    for (const cluster of clusters) {
      try {
        // Existing pattern by signature?
        const [existing] = await opts.db
          .select()
          .from(outcomePatterns)
          .where(
            and(
              eq(outcomePatterns.companyId, companyId),
              eq(outcomePatterns.patternName, cluster.signature),
            ),
          )
          .orderBy(desc(outcomePatterns.derivedAt))
          .limit(1);

        if (existing) {
          const merged = Array.from(
            new Set([...(existing.exemplarRunIds ?? []), ...cluster.exemplarRunIds]),
          ).slice(0, 5);
          await opts.db
            .update(outcomePatterns)
            .set({
              exemplarRunIds: merged,
              clusterSize: existing.clusterSize + cluster.size,
              confidence: Math.min(0.95, (existing.clusterSize + cluster.size) / 10),
              derivedAt: now,
            })
            .where(eq(outcomePatterns.id, existing.id));
          rowsUpdated++;
        } else {
          let name = cluster.representativeTitle;
          let description: string | null = null;
          if (opts.llm && llmCallsRemaining > 0) {
            llmCallsRemaining--;
            try {
              const raw = await opts.llm.generate({
                system: SYSTEM_PROMPT,
                user: `Cluster of run titles:\n${cluster.exemplarRunIds
                  .map((_id, i) => `${i + 1}. ${forCluster.find((f) => f.runId === cluster.exemplarRunIds[i])?.title ?? cluster.representativeTitle}`)
                  .join("\n")}`,
              });
              const parsed = parseLlmResponse(raw);
              if (parsed) {
                name = parsed.name;
                description = parsed.description;
              }
            } catch (err) {
              errors++;
              // eslint-disable-next-line no-console
              console.warn("[learning.pattern-miner] LLM call failed", err);
            }
          }
          await opts.db.insert(outcomePatterns).values({
            companyId,
            patternName: cluster.signature, // store signature as the canonical name for dedup
            patternDescription: description ?? name,
            exemplarRunIds: cluster.exemplarRunIds,
            clusterSize: cluster.size,
            confidence: Math.min(0.9, cluster.size / 10),
          });
          rowsInserted++;
        }
      } catch (err) {
        errors++;
        // eslint-disable-next-line no-console
        console.warn("[learning.pattern-miner] cluster handling failed", err);
      }
    }
  }

  return { clustersFound, rowsInserted, rowsUpdated, errors };
}

function readTitle(ctx: Record<string, unknown> | null): string {
  if (!ctx) return "";
  const v = ctx.issueTitle ?? ctx.title;
  return typeof v === "string" ? v.trim() : "";
}

function parseLlmResponse(raw: string): { name: string; description: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (typeof obj?.name !== "string") return null;
    return { name: obj.name, description: typeof obj.description === "string" ? obj.description : "" };
  } catch {
    return null;
  }
}
