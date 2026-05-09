// Work-queue REST surface.
//
// Public:
//   POST /api/companies/:companyId/work-queue/:queue/items
//     Body: { targetIssueId?, targetAgentId?, routineId?, payload?,
//              priority?, maxAttempts?, retryPolicy?, availableAt? }
//     Headers: Idempotency-Key (Stripe-style) → maps to dedupe_key.
//     Returns: EnqueueResult.
//
// Admin:
//   POST /admin/work-queue/replay/:itemId  → replays a dead_letter row
//   POST /admin/work-queue/cancel/:itemId  → cancels a queued/running row
//   GET  /admin/work-queue/depth           → per-company depth gauge
//   GET  /admin/work-queue/dead-letter     → recent dead-letter rows
//
// Tenant gate: derives companyId from the path or row lookup, then
// assertCompanyAccess + service-layer assertTenant. Defense in depth.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { workItems } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getWorkQueueService } from "../services/work-queue/service.js";
import { pokeScheduler } from "../services/work-queue/poke.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";

const enqueueBodySchema = z.object({
  targetIssueId: z.string().uuid().optional(),
  targetAgentId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  retryPolicy: z.record(z.unknown()).optional(),
  availableAt: z.string().datetime().optional(),
});

export function workQueueRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/work-queue/:queue/items",
    validate(enqueueBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const queue = req.params.queue as string;
      assertCompanyAccess(req, companyId);

      const idempotencyHeader = req.header("Idempotency-Key") ?? req.header("idempotency-key");
      const dedupeKey = idempotencyHeader && idempotencyHeader.trim().length > 0
        ? idempotencyHeader.trim()
        : undefined;
      const body = req.body as z.infer<typeof enqueueBodySchema>;
      const svc = getWorkQueueService();

      const result = await svc.enqueue(
        { callerCompanyId: companyId },
        {
          companyId,
          queue,
          priority: body.priority,
          dedupeKey,
          targetIssueId: body.targetIssueId,
          targetAgentId: body.targetAgentId,
          routineId: body.routineId,
          payload: body.payload,
          maxAttempts: body.maxAttempts,
          retryPolicy:
            (body.retryPolicy as Record<string, unknown> | undefined) ?? undefined,
          availableAt: body.availableAt ? new Date(body.availableAt) : undefined,
          enqueuedByKind: "webhook",
          enqueuedByRef:
            req.actor.type === "agent" ? req.actor.agentId ?? undefined : undefined,
        },
      );
      if (result.enqueued) pokeScheduler(companyId);
      // 201 on first-write, 200 on duplicate (Stripe-style)
      res.status(result.enqueued ? 201 : 200).json(result);
    },
  );

  router.get("/admin/work-queue", async (req, res) => {
    assertInstanceAdmin(req);
    const depthRows = await db.execute<{
      company_id: string;
      queue: string;
      depth: number;
    }>(
      // Per (company, queue) depth.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((await import("drizzle-orm")) as any).sql`
        SELECT company_id, queue, COUNT(*)::int AS depth
        FROM work_items
        WHERE state = 'queued'
        GROUP BY company_id, queue
        ORDER BY depth DESC
      `,
    );
    const deadLetterRows = await db
      .select()
      .from(workItems)
      .where(eq(workItems.state, "dead_letter"))
      .limit(200);
    const depth = (Array.isArray(depthRows)
      ? depthRows
      : (depthRows as { rows?: Array<{ company_id: string; queue: string; depth: number }> }).rows ?? []
    ) as Array<{ company_id: string; queue: string; depth: number }>;
    res.json({
      depth: depth.map((r) => ({
        companyId: r.company_id,
        queue: r.queue,
        depth: r.depth,
      })),
      deadLetter: deadLetterRows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        queue: r.queue,
        priority: r.priority,
        state: r.state,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        enqueuedByKind: r.enqueuedByKind,
        enqueuedAt: r.enqueuedAt instanceof Date ? r.enqueuedAt.toISOString() : r.enqueuedAt,
        startedAt:
          r.startedAt instanceof Date
            ? r.startedAt.toISOString()
            : (r.startedAt as string | null),
        completedAt:
          r.completedAt instanceof Date
            ? r.completedAt.toISOString()
            : (r.completedAt as string | null),
        lastError: r.lastError,
        lastErrorCode: r.lastErrorCode,
      })),
    });
  });

  router.post("/admin/work-queue/replay/:itemId", async (req, res) => {
    assertInstanceAdmin(req);
    const id = req.params.itemId as string;
    const peek = await peekItem(db, id);
    if (!peek) throw notFound("work item not found");
    const resetAttempts =
      typeof req.body?.resetAttempts === "boolean" ? req.body.resetAttempts : true;
    const svc = getWorkQueueService();
    await svc.replayDeadLetter(
      { callerCompanyId: peek.companyId },
      { id, companyId: peek.companyId, resetAttempts },
    );
    res.json({ ok: true });
  });

  router.post("/admin/work-queue/cancel/:itemId", async (req, res) => {
    assertInstanceAdmin(req);
    const id = req.params.itemId as string;
    const peek = await peekItem(db, id);
    if (!peek) throw notFound("work item not found");
    const svc = getWorkQueueService();
    await svc.cancel(
      { callerCompanyId: peek.companyId },
      { id, companyId: peek.companyId },
    );
    res.json({ ok: true });
  });

  return router;
}

async function peekItem(db: Db, id: string): Promise<{ companyId: string } | null> {
  const [row] = await db
    .select({ companyId: workItems.companyId })
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);
  return row ? { companyId: row.companyId } : null;
}
