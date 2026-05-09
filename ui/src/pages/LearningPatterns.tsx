// /learning/patterns — outcome + decision patterns side-by-side.
// Read-only dashboard; promotion + curation lives at /admin/learning.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { listDecisionPatterns, listOutcomePatterns } from "@/api/learning";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

export function LearningPatterns() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(
    () => setBreadcrumbs([{ label: "Patterns" }]),
    [setBreadcrumbs],
  );
  const url = new URL(window.location.href);
  const companyId = url.pathname.split("/").filter(Boolean)[0] ?? "";

  const outcomesQ = useQuery({
    queryKey: ["learning-patterns-public", companyId],
    queryFn: () => listOutcomePatterns(companyId),
    enabled: !!companyId,
  });
  const decisionsQ = useQuery({
    queryKey: ["learning-decisions-public", companyId],
    queryFn: () => listDecisionPatterns(companyId),
    enabled: !!companyId,
  });

  if (!companyId)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open from inside a company context.
      </div>
    );

  const outcomes = outcomesQ.data?.patterns ?? [];
  const decisions = decisionsQ.data?.patterns ?? [];

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-xl font-semibold">Patterns</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Outcome patterns
          </h2>
          {outcomesQ.isLoading ? (
            <div className="text-sm">Loading…</div>
          ) : outcomes.length === 0 ? (
            <div className="text-sm text-muted-foreground">No outcome patterns yet.</div>
          ) : (
            <ul className="space-y-2">
              {outcomes.map((p) => (
                <li key={p.id} className="rounded-md border bg-card p-3">
                  <div className="text-sm font-medium">
                    {p.patternDescription ?? p.patternName}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {p.clusterSize} runs · confidence {(p.confidence * 100).toFixed(0)}%
                    {p.promotedToPlaybookId ? " · promoted" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Decision patterns
          </h2>
          {decisionsQ.isLoading ? (
            <div className="text-sm">Loading…</div>
          ) : decisions.length === 0 ? (
            <div className="text-sm text-muted-foreground">No decision patterns yet.</div>
          ) : (
            <ul className="space-y-2">
              {decisions.map((d) => (
                <li key={d.id} className="rounded-md border bg-card p-3">
                  <div className="text-sm font-medium">{d.conditionSummary}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Typical:{" "}
                    <span className="font-medium text-foreground">{d.typicalChoice}</span>{" "}
                    · {d.clusterSize} examples · confidence {(d.confidence * 100).toFixed(0)}%
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
