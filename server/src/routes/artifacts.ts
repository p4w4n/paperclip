// Artifacts REST surface. Three endpoints:
//
//   GET /api/issues/:issueId/artifacts → list non-superseded
//     artifacts attached to an issue. ?includeSuperseded=true
//     surfaces the full revision history.
//
//   GET /api/artifacts/:id → single fetch.
//
//   GET /preview/:artifactId/* → preview-provider passthrough.
//     v1 only handles the local provider; remote URLs are 302
//     redirects.
//
// Tenant isolation flows from the issue/artifact row's company_id —
// we look up the row, then assertCompanyAccess on req.actor against
// that company. Service-layer assertTenant gates the query against
// the same company; defense in depth.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { issueService } from "../services/index.js";
import { getArtifactsService } from "../services/artifacts/service.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export function artifactsRoutes(db: Db) {
  const router = Router();
  const issueSvc = issueService(db);

  router.get("/issues/:issueId/artifacts", async (req, res) => {
    const rawId = req.params.issueId as string;
    const identifier = normalizeIssueIdentifier(rawId);
    const issue = identifier
      ? await issueSvc.getByIdentifier(identifier)
      : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const includeSuperseded = req.query.includeSuperseded === "true";
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const svc = getArtifactsService();
    const rows = await svc.list(
      { callerCompanyId: issue.companyId },
      {
        companyId: issue.companyId,
        issueId: issue.id,
        includeSuperseded,
        limit,
      },
    );
    res.json({ artifacts: rows });
  });

  router.get("/artifacts/:id", async (req, res) => {
    const id = req.params.id as string;
    // Look up the artifact's row directly to derive its company,
    // then gate on access. Avoids exposing arbitrary IDs across
    // tenants (the service-level tenant gate would 403 anyway,
    // but a 404 hides the existence).
    const svc = getArtifactsService();
    // Pre-lookup by id — without assertCompanyAccess yet, we use a
    // narrow read to derive the company. Since the service layer
    // only takes ctx + (id, companyId), we read the row via db here.
    const row = await peekArtifact(db, id);
    if (!row) throw notFound("artifact not found");
    assertCompanyAccess(req, row.companyId);
    const hydrated = await svc.get(
      { callerCompanyId: row.companyId },
      { id, companyId: row.companyId },
    );
    if (!hydrated) throw notFound("artifact not found");
    res.json({ artifact: hydrated });
  });

  router.get("/preview/:artifactId/*", async (req, res) => {
    const id = req.params.artifactId as string;
    const row = await peekArtifact(db, id);
    if (!row) throw notFound("artifact not found");
    assertCompanyAccess(req, row.companyId);
    const svc = getArtifactsService();
    const hydrated = await svc.get(
      { callerCompanyId: row.companyId },
      { id, companyId: row.companyId },
    );
    if (!hydrated) throw notFound("artifact not found");
    if (!hydrated.previewUrl) {
      res.status(404).json({ error: "preview not available" });
      return;
    }
    if (hydrated.previewExpiresAt && hydrated.previewExpiresAt < new Date()) {
      res.status(410).json({ error: "preview expired" });
      return;
    }
    res.redirect(hydrated.previewUrl);
  });

  return router;
}

async function peekArtifact(
  db: Db,
  id: string,
): Promise<{ companyId: string } | null> {
  const { artifacts } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ companyId: artifacts.companyId })
    .from(artifacts)
    .where(eq(artifacts.id, id))
    .limit(1);
  return row ? { companyId: row.companyId } : null;
}
