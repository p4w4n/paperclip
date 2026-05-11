import { Router } from "express";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { companies, githubWebhookDeliveries } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  ingestGithubWebhook,
  GitHubWebhookSecretNotConfiguredError,
} from "../services/outcomes/webhooks/github.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export function webhooksRoutes(db: Db): Router {
  const r = Router();

  // POST /companies/:cid/webhooks/github
  // No auth — HMAC-verified inside ingestGithubWebhook.
  r.post("/companies/:cid/webhooks/github", async (req, res, next) => {
    try {
      const deliveryId = req.header("X-GitHub-Delivery");
      const eventType = req.header("X-GitHub-Event") ?? "";
      const signature = req.header("X-Hub-Signature-256") ?? "";

      if (!deliveryId) {
        return res.status(400).json({ error: "X-GitHub-Delivery required" });
      }

      const rawBody =
        ((req as any).rawBody as Buffer | undefined)?.toString("utf-8") ?? "";

      const result = await ingestGithubWebhook(db, {
        companyId: req.params.cid,
        deliveryId,
        eventType,
        signature,
        rawBody,
      });

      const status = result.result === "invalid_signature" ? 401 : 200;
      return res.status(status).json(result);
    } catch (e) {
      if (e instanceof GitHubWebhookSecretNotConfiguredError) {
        return res.status(404).json({ error: (e as Error).message });
      }
      next(e);
    }
  });

  // POST /companies/:cid/webhooks/github/_secret/rotate
  // Admin-only: generates a fresh ghw_<hex> secret.
  r.post("/companies/:cid/webhooks/github/_secret/rotate", async (req, res, next) => {
    try {
      assertInstanceAdmin(req);
      const secret = `ghw_${randomBytes(32).toString("hex")}`;
      await db
        .update(companies)
        .set({ githubWebhookSecret: secret })
        .where(eq(companies.id, req.params.cid));
      return res.json({
        secret,
        instructions: `Configure this as the GitHub webhook secret at your repo's Settings → Webhooks`,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /companies/:cid/webhooks/github/deliveries
  // Audit listing — assertCompanyAccess.
  r.get("/companies/:cid/webhooks/github/deliveries", async (req, res, next) => {
    try {
      assertCompanyAccess(req, req.params.cid);
      const rows = await db
        .select()
        .from(githubWebhookDeliveries)
        .where(eq(githubWebhookDeliveries.companyId, req.params.cid))
        .orderBy(desc(githubWebhookDeliveries.receivedAt))
        .limit(50);
      return res.json({ deliveries: rows });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
