// Parent-chain helper. Given a (companyId, issueId|null, name)
// scope, return the latest non-superseded artifact id at that key
// — that's the parent the new declaration chains off. The partial
// unique index on (issue_id, name) WHERE superseded_at IS NULL
// guarantees there's at most one match.
//
// Pure on the input; reads via the injected db handle.

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifacts } from "@paperclipai/db";

export interface FindParentInput {
  db: Db;
  companyId: string;
  issueId: string | null;
  name: string;
}

export async function findParentForName(
  input: FindParentInput,
): Promise<string | null> {
  const rows = await input.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.companyId, input.companyId),
        input.issueId === null
          ? isNull(artifacts.issueId)
          : eq(artifacts.issueId, input.issueId),
        eq(artifacts.name, input.name),
        isNull(artifacts.supersededAt),
      ),
    )
    .orderBy(desc(artifacts.declaredAt))
    .limit(1);
  return rows[0]?.id ?? null;
}
