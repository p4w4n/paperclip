// Outcomes REST surface.
//
//   GET  /api/companies/:cid/outcomes?target_kind=&target_id=    list outcomes for company (optionally filtered by target)
//   GET  /api/companies/:cid/outcomes/:id                        single outcome
//   POST /api/companies/:cid/outcomes/:id/signoff                manual sign-off
//   POST /api/companies/:cid/outcomes/:id/signal                 external webhook signal (HMAC + Idempotency-Key)
//   POST /api/companies/:cid/outcomes/:id/revert                 flip verified → reverted
//   POST /api/companies/:cid/outcomes/_secrets/signal/rotate     rotate per-company HMAC secret (instance admin)
//   GET  /api/instance/outcomes                                   all outcomes, instance admin only
//
// Raw-body approach: app.ts already sets up express.json({ verify: (req, _res, buf) => {
//   (req as any).rawBody = buf; } }) globally. Every inbound JSON body — including the
// /signal endpoint — therefore has req.rawBody populated as a Buffer before this handler
// runs. We convert it to a string (UTF-8) and pass it to ingestExternalSignal which
// computes HMAC over the byte-exact body.

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outcomes, companies } from "@paperclipai/db";
import { getOutcomesService } from "../services/outcomes/service.js";
import { OutcomeRequiredError } from "../services/outcomes/types.js";
import { groupBySlot, baseNameOf, isSlotSatisfied } from "../services/outcomes/alias-resolver.js";
import {
  SignalAuthError,
  SignalReplayMismatchError,
} from "../services/outcomes/verifiers/external-signal.js";
import { SignoffRoleMismatchError } from "../services/outcomes/verifiers/manual-signoff.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

export function outcomesRoutes(db: Db) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // GET /companies/:cid/outcomes
  // ---------------------------------------------------------------------------
  router.get("/companies/:cid/outcomes", async (req, res) => {
    const cid = req.params.cid as string;
    assertCompanyAccess(req, cid);

    const svc = getOutcomesService();

    const targetKind = typeof req.query.target_kind === "string" ? req.query.target_kind : undefined;
    const targetId = typeof req.query.target_id === "string" ? req.query.target_id : undefined;

    let rows;
    if (targetKind && targetId) {
      rows = await svc.listForTarget({ kind: targetKind as "issue" | "plan", id: targetId, companyId: cid });
    } else {
      // No target filter: return all outcomes for this company.
      rows = await db.select().from(outcomes).where(eq(outcomes.companyId, cid));
    }

    // Normalise rows so alias helpers never see undefined name.
    const normalised = (rows as any[]).map((r) => ({
      ...r,
      requiredMeta: { ...r.requiredMeta, name: r.requiredMeta?.name ?? "" },
    }));
    const groups = groupBySlot(normalised);
    const enriched = normalised.map((r) => {
      const rawName: string = r.requiredMeta.name;
      const baseName = baseNameOf(rawName);
      const slotRows = groups[baseName] ?? [];
      return {
        ...r,
        slot_base_name: baseName,
        slot_satisfied: isSlotSatisfied(slotRows, baseName),
        alternatives:
          rawName === baseName
            ? slotRows.filter((s: any) => s.requiredMeta.name !== baseName)
            : [],
      };
    });
    res.json({ outcomes: enriched });
  });

  // ---------------------------------------------------------------------------
  // GET /companies/:cid/outcomes/:id
  // ---------------------------------------------------------------------------
  router.get("/companies/:cid/outcomes/:id", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);

    const rows = await db
      .select()
      .from(outcomes)
      .where(and(eq(outcomes.id, id), eq(outcomes.companyId, cid)));

    if (rows.length === 0) throw notFound("Outcome not found");
    res.json({ outcome: rows[0] });
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:cid/outcomes/:id/signoff
  // ---------------------------------------------------------------------------
  router.post("/companies/:cid/outcomes/:id/signoff", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);

    const userId = req.actor.userId ?? "board";
    // Derive userRole from the actor's membership in this company.
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((m) => m.companyId === cid)
      : undefined;
    const userRole = membership?.membershipRole ?? null;
    const note: string | undefined = typeof req.body?.note === "string" ? req.body.note : undefined;

    const svc = getOutcomesService();
    try {
      const result = await svc.signOff({ outcomeId: id, companyId: cid, userId, userRole, note });
      res.json(result);
    } catch (err) {
      if (err instanceof OutcomeRequiredError) {
        res.status(422).json(err.body);
        return;
      }
      if (err instanceof SignoffRoleMismatchError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:cid/outcomes/:id/signal  — external webhook signal
  //
  // Requires:
  //   X-Signature-256: sha256=<hex>   (HMAC over the raw request body)
  //   Idempotency-Key: <opaque key>   (required; returns 400 if missing)
  //
  // Raw body: express.json verify callback in app.ts stashes the raw Buffer at
  // req.rawBody before JSON parsing. We stringify it here for HMAC comparison.
  // ---------------------------------------------------------------------------
  router.post("/companies/:cid/outcomes/:id/signal", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);

    const idempotencyKey = req.headers["idempotency-key"];
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw badRequest("Idempotency-Key header is required");
    }

    const signature = req.headers["x-signature-256"];
    if (!signature || typeof signature !== "string") {
      throw badRequest("X-Signature-256 header is required");
    }

    // Use the stashed raw Buffer from the express.json verify callback.
    const rawBuf = (req as any).rawBody as Buffer | undefined;
    const rawBody = rawBuf ? rawBuf.toString("utf-8") : "";

    const svc = getOutcomesService();
    try {
      const result = await svc.ingestSignal({
        outcomeId: id,
        companyId: cid,
        rawBody,
        signature,
        idempotencyKey,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof SignalAuthError) {
        res.status(401).json({ error: err.message });
        return;
      }
      if (err instanceof SignalReplayMismatchError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof OutcomeRequiredError) {
        res.status(422).json(err.body);
        return;
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:cid/outcomes/:id/revert
  // ---------------------------------------------------------------------------
  router.post("/companies/:cid/outcomes/:id/revert", async (req, res) => {
    const cid = req.params.cid as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, cid);

    const reason: string = typeof req.body?.reason === "string" ? req.body.reason : "reverted";

    // Scope to company — only revert if outcome belongs to this company.
    const rows = await db
      .select()
      .from(outcomes)
      .where(and(eq(outcomes.id, id), eq(outcomes.companyId, cid)));

    if (rows.length === 0) throw notFound("Outcome not found");

    const svc = getOutcomesService();
    try {
      const r2 = await svc.revertOutcome(id, reason);
      res.json({
        ...r2,
        parent_reopened: r2.parentReopened,
        slot_still_satisfied: r2.slotStillSatisfied,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "Outcome not in verified state") {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:cid/outcomes/_secrets/signal/rotate
  //
  // Instance-admin only. Generates a new 32-byte hex secret, writes it to
  // companies.outcomeSignalSecret, and returns it in the response body *once*.
  // ---------------------------------------------------------------------------
  router.post("/companies/:cid/outcomes/_secrets/signal/rotate", async (req, res) => {
    const cid = req.params.cid as string;
    assertInstanceAdmin(req);

    const newSecret = randomBytes(32).toString("hex");

    await db
      .update(companies)
      .set({ outcomeSignalSecret: newSecret })
      .where(eq(companies.id, cid));

    res.json({ secret: newSecret });
  });

  // ---------------------------------------------------------------------------
  // GET /instance/outcomes  — instance admin: all outcomes across all companies
  // ---------------------------------------------------------------------------
  router.get("/instance/outcomes", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db.select().from(outcomes);
    res.json({ outcomes: rows });
  });

  return router;
}
