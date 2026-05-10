// Standalone plan detail page. Displays plan info, phases, reviews, decisions,
// and an Outcomes tab. The "Complete" phase button is disabled when pending
// outcomes exist for this plan.
import { useState, useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPlan,
  completePhase,
  startPhase,
  type PlanRow,
} from "@/api/plans";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { PhaseTree } from "@/features/issues/plan-tab/PhaseTree";
import { RevisionDiff } from "@/features/issues/plan-tab/RevisionDiff";
import { DecisionLog } from "@/features/issues/plan-tab/DecisionLog";
import { ReviewSurface } from "@/features/issues/plan-tab/ReviewSurface";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OutcomesTab } from "../components/OutcomesTab";
import { useCompany } from "../context/CompanyContext";

export function PlanDetail() {
  const { planId } = useParams<{ planId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState("phases");
  const [pendingOutcomes, setPendingOutcomes] = useState(0);

  const planQ = useQuery({
    queryKey: ["plan", planId],
    enabled: !!planId,
    queryFn: () => (planId ? getPlan(planId) : Promise.resolve(null)),
  });

  useEffect(() => {
    if (planQ.data?.plan) {
      setBreadcrumbs([
        { label: "Plans", href: "/plans" },
        { label: planQ.data.plan.title },
      ]);
    }
  }, [planQ.data?.plan, setBreadcrumbs]);

  if (!planId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">No plan ID provided.</div>
    );
  }
  if (planQ.isLoading) return <div className="p-4 text-sm">Loading…</div>;
  if (planQ.error || !planQ.data) {
    return <div className="p-4 text-sm text-destructive">Failed to load plan.</div>;
  }

  const { plan, currentRevision, phases } = planQ.data;

  const companyId = selectedCompanyId ?? plan.companyId;

  const onStart = async (phaseId: string) => {
    setBusy(phaseId);
    try {
      await startPhase(plan.id, phaseId);
      await queryClient.invalidateQueries({ queryKey: ["plan", planId] });
    } finally {
      setBusy(null);
    }
  };

  const onComplete = async (phaseId: string) => {
    setBusy(phaseId);
    try {
      await completePhase(plan.id, phaseId);
      await queryClient.invalidateQueries({ queryKey: ["plan", planId] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <PlanHeader plan={plan} />

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Current revision (#{plan.currentRevisionNumber})
        </h3>
        <article className="prose prose-sm max-w-none rounded-md border bg-card p-4">
          {currentRevision?.contentMarkdown ?? "(no content)"}
        </article>
      </section>

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="phases" className="gap-1.5">
            Phases
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-1.5">
            Reviews
          </TabsTrigger>
          <TabsTrigger value="decisions" className="gap-1.5">
            Decisions
          </TabsTrigger>
          <TabsTrigger value="diff" className="gap-1.5">
            Revision diff
          </TabsTrigger>
          <TabsTrigger value="outcomes" className="gap-1.5">
            Outcomes
            {pendingOutcomes > 0 && (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                {pendingOutcomes}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="phases">
          <PhaseTree
            phases={phases}
            onStart={onStart}
            onComplete={pendingOutcomes > 0 ? undefined : onComplete}
            busy={busy}
            disabledCompleteReason={
              pendingOutcomes > 0
                ? `${pendingOutcomes} outcome(s) still pending`
                : undefined
            }
          />
        </TabsContent>

        <TabsContent value="reviews">
          <ReviewSurface
            planId={plan.id}
            canReview={plan.status === "under_review" || plan.status === "draft"}
          />
        </TabsContent>

        <TabsContent value="decisions">
          <DecisionLog planId={plan.id} />
        </TabsContent>

        <TabsContent value="diff">
          <RevisionDiff planId={plan.id} />
        </TabsContent>

        <TabsContent value="outcomes">
          {detailTab === "outcomes" ? (
            <OutcomesTab
              target={{ kind: "plan", id: plan.id, companyId }}
              onPendingCountChange={setPendingOutcomes}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlanHeader({ plan }: { plan: PlanRow }) {
  return (
    <div className="flex items-baseline gap-3">
      <h2 className="text-lg font-semibold">{plan.title}</h2>
      <StatusBadge status={plan.status} />
      <span className="text-xs text-muted-foreground">
        rev {plan.currentRevisionNumber}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "approved" || status === "completed"
      ? "bg-green-100 text-green-700"
      : status === "rejected" || status === "cancelled"
        ? "bg-red-100 text-red-700"
        : status === "in_progress"
          ? "bg-blue-100 text-blue-700"
          : "bg-amber-100 text-amber-700";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
