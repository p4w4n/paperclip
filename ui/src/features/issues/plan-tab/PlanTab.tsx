import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completePhase,
  getPlan,
  startPhase,
  type PlanRow,
} from "@/api/plans";
import { PhaseTree } from "./PhaseTree";
import { RevisionDiff } from "./RevisionDiff";
import { DecisionLog } from "./DecisionLog";
import { ReviewSurface } from "./ReviewSurface";

interface PlanTabProps {
  issueId: string;
  // The active plan id for the issue. v1 supports a single plan per
  // issue; multi-plan dashboards live in Plan 2.
  planId: string | null;
}

export function PlanTab({ planId }: PlanTabProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const planQ = useQuery({
    queryKey: ["plan", planId],
    enabled: !!planId,
    queryFn: () => (planId ? getPlan(planId) : Promise.resolve(null)),
  });

  if (!planId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No plan attached to this issue. Use the Create plan action to start one.
      </div>
    );
  }
  if (planQ.isLoading) return <div className="p-4 text-sm">Loading…</div>;
  if (planQ.error || !planQ.data)
    return <div className="p-4 text-sm text-destructive">Failed to load plan.</div>;

  const { plan, currentRevision, phases } = planQ.data;

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
    <div className="space-y-4">
      <PlanHeader plan={plan} />
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Current revision (#{plan.currentRevisionNumber})
        </h3>
        <article className="prose prose-sm max-w-none rounded-md border bg-card p-4">
          {currentRevision?.contentMarkdown ?? "(no content)"}
        </article>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Phases
        </h3>
        <PhaseTree
          phases={phases}
          onStart={onStart}
          onComplete={onComplete}
          busy={busy}
        />
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Reviews
        </h3>
        <ReviewSurface planId={plan.id} canReview={plan.status === "under_review" || plan.status === "draft"} />
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Decisions
        </h3>
        <DecisionLog planId={plan.id} />
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Revision diff
        </h3>
        <RevisionDiff planId={plan.id} />
      </section>
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
