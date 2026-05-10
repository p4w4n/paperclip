// Memory subscriber for outcome events. Writes procedural memory entries
// when outcomes are verified or reverted, so that agents can recall past
// outcome patterns during future planning.
//
// Failures are best-effort — memory ingest must never crash the source flow.

import type { MemoryService } from "./service.js";

export interface OutcomeVerifiedEvent {
  kind: string;
  targetKind: string;
  targetId: string;
  companyId: string;
  verifiedMeta?: unknown;
}

export interface OutcomeRevertedEvent {
  kind: string;
  targetKind: string;
  targetId: string;
  companyId: string;
  reason: string;
}

export function attachMemoryOutcomeSubscriber(memory: MemoryService) {
  return {
    async onVerified(e: OutcomeVerifiedEvent): Promise<void> {
      try {
        await memory.write(
          { callerCompanyId: e.companyId },
          {
            scope: { companyId: e.companyId },
            kind: "procedural",
            content: `Outcome verified: ${e.kind} — target ${e.targetKind}/${e.targetId}`,
            payload:
              e.verifiedMeta != null
                ? { verified_meta: e.verifiedMeta as Record<string, unknown> }
                : undefined,
          },
        );
      } catch (err) {
        // Memory ingest is best-effort.
        console.warn("[outcomes→memory] verified ingest failed", { err });
      }
    },

    async onReverted(e: OutcomeRevertedEvent): Promise<void> {
      try {
        await memory.write(
          { callerCompanyId: e.companyId },
          {
            scope: { companyId: e.companyId },
            kind: "procedural",
            content: `Outcome reverted: ${e.kind} — target ${e.targetKind}/${e.targetId}: ${e.reason}`,
          },
        );
      } catch (err) {
        console.warn("[outcomes→memory] reverted ingest failed", { err });
      }
    },
  };
}
