// Preview reaper. Same lease-reaper pattern as Plan 2 of
// distributed-workers and the memory reflection worker:
//   - reapExpiredPreviews(db, lookupProvider): pure tick. Selects
//     artifacts where preview_expires_at < now AND preview_url is
//     set, calls the provider's teardown (best-effort), nulls the
//     URL columns.
//   - startPreviewReaper(opts): production wire with setInterval.unref().
//
// Failure modes:
//   - Provider lookup returns null → still null the URL (the URL
//     was useless anyway).
//   - teardown throws → log + continue (don't stall the rest of
//     the batch).

import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifacts } from "@paperclipai/db";
import { getPreviewProviderById } from "./registry.js";

export interface ReapTickResult {
  reaped: number;
  errors: number;
}

export async function reapExpiredPreviews(
  db: Db,
  now: Date = new Date(),
  batchSize = 64,
): Promise<ReapTickResult> {
  const expired = await db
    .select({
      id: artifacts.id,
      previewProvider: artifacts.previewProvider,
    })
    .from(artifacts)
    .where(
      and(
        isNotNull(artifacts.previewUrl),
        lt(artifacts.previewExpiresAt, now),
      ),
    )
    .limit(batchSize);

  let reaped = 0;
  let errors = 0;

  for (const row of expired) {
    if (row.previewProvider) {
      const provider = getPreviewProviderById(row.previewProvider);
      if (provider?.teardown) {
        try {
          await provider.teardown({ artifactId: row.id });
        } catch (err) {
          errors++;
          // eslint-disable-next-line no-console
          console.warn(
            `[artifacts.preview-reaper] teardown failed for ${row.id}`,
            err,
          );
        }
      }
    }
    await db
      .update(artifacts)
      .set({
        previewUrl: null,
        previewExpiresAt: null,
        previewProvider: null,
      })
      .where(eq(artifacts.id, row.id));
    reaped++;
  }

  return { reaped, errors };
}

export interface PreviewReaperOpts {
  db: Db;
  intervalMs?: number; // default 5min per spec
  batchSize?: number;
}

export function startPreviewReaper(opts: PreviewReaperOpts): { stop: () => void } {
  const interval = opts.intervalMs ?? 5 * 60_000;
  const batchSize = opts.batchSize ?? 64;
  const handle = setInterval(() => {
    void reapExpiredPreviews(opts.db, new Date(), batchSize).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[artifacts.preview-reaper] tick crashed", err);
    });
  }, interval);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
}
