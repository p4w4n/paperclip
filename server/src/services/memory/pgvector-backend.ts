// Default MemoryBackend — fact-per-row storage on Postgres+pgvector.
// Embedding is left null on write (the reflection worker handles it
// via the embedding pipeline in M-12). Salience defaults to 0.5
// (matches the spec). Scope columns map straight from the input;
// recall (M-8) ranks across them with the union-rank query.
//
// pgvector availability: the migration in M-1 wraps the partial HNSW
// index in DO blocks so creation succeeds on environments without
// the extension; recall queries (M-8) check at runtime and fall back
// to keyword search. Write/forget paths don't depend on pgvector.

import { eq, and, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryEntries } from "@paperclipai/db";
import type {
  ForgetInput,
  MemoryBackend,
  RecallInput,
  RecalledEntry,
  WriteInput,
} from "./types.js";

export function createPgvectorMemoryBackend(db: Db): MemoryBackend {
  return {
    async write(input: WriteInput) {
      const [row] = await db
        .insert(memoryEntries)
        .values({
          companyId: input.scope.companyId,
          userId: input.scope.userId ?? null,
          agentId: input.scope.agentId ?? null,
          sessionId: input.scope.sessionId ?? null,
          sessionKind: input.scope.sessionKind ?? null,
          kind: input.kind,
          content: input.content,
          payload: (input.payload ?? null) as Record<string, unknown> | null,
          sourceRunId: input.sourceRunId ?? null,
          // embedding stays null — reflection worker (M-12) populates
          // asynchronously. Salience + use_count + created_at use
          // their schema defaults (0.5, 0, now()).
        })
        .returning({ id: memoryEntries.id });
      return { id: row.id };
    },

    // recall lands in M-8.
    async recall(_input: RecallInput): Promise<RecalledEntry[]> {
      throw new Error("recall not yet implemented (M-8)");
    },

    async forget(input: ForgetInput) {
      // M-10 will add forget_reason; this stub gets us through M-3
      // without breaking the interface contract.
      await db
        .update(memoryEntries)
        .set({
          supersededAt: new Date(),
          forgetReason: input.reason,
        })
        .where(and(eq(memoryEntries.id, input.id), isNull(memoryEntries.supersededAt)));
    },
  };
}
