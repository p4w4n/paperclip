// On plan completion: ingest the plan into memory.
//
// Two writes per completed plan:
//   1. memory.upsertPage with kind=procedural — the final revision
//      content + a "Completed plan: ${title}" header. Slug is
//      `plan-${planId}-final` so re-completion (rare; cancel +
//      restart) supersedes via the existing wiki-page versioning.
//   2. memory.write per plan_decision with kind=semantic — the
//      decision title + chosen option + rationale.
//
// All writes are fire-and-forget on the call site (DP-7 catches
// errors). Memory failures must not stall the plan's terminal
// transition.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { planDecisions, planRevisions, plans } from "@paperclipai/db";
import type { MemoryService } from "./memory-service-shape.js";

export async function ingestCompletedPlan(
  db: Db,
  memory: MemoryService,
  planId: string,
): Promise<{ pageId: string | null; factsWritten: number }> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) return { pageId: null, factsWritten: 0 };

  let pageId: string | null = null;
  let factsWritten = 0;

  if (plan.currentRevisionId) {
    const [rev] = await db
      .select({ contentMarkdown: planRevisions.contentMarkdown })
      .from(planRevisions)
      .where(eq(planRevisions.id, plan.currentRevisionId));
    if (rev) {
      const slug = `plan-${planId}-final`;
      const body = `# Completed plan: ${plan.title}\n\n${rev.contentMarkdown}`;
      const result = await memory.upsertPage(
        { callerCompanyId: plan.companyId },
        {
          scope: { companyId: plan.companyId },
          slug,
          title: plan.title,
          contentMarkdown: body,
        },
      );
      pageId = result.id;
    }
  }

  const decisions = await db
    .select()
    .from(planDecisions)
    .where(eq(planDecisions.planId, planId));
  for (const d of decisions) {
    const chosen = (d.optionsJson as Array<{ id: string; label: string }>).find(
      (o) => o.id === d.chosenOptionId,
    );
    const content = `Decision (${plan.title}) — ${d.title}: chose '${chosen?.label ?? d.chosenOptionId}'.${
      d.rationaleMarkdown ? ` Rationale: ${d.rationaleMarkdown}` : ""
    }`;
    await memory.write(
      { callerCompanyId: plan.companyId },
      {
        scope: { companyId: plan.companyId },
        kind: "semantic",
        content,
      },
    );
    factsWritten++;
  }

  return { pageId, factsWritten };
}
