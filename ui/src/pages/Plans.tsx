// /plans index page — lists active plans across the company
// the current user is viewing. Filterable by status. Reuses the
// existing dashboard primitives.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAllPlans, type PlanRow } from "@/api/plans";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "under_review", label: "Under review" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

export function Plans() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Plans" }]);
  }, [setBreadcrumbs]);

  // The page is rendered inside a company context; we read the
  // company id from the existing context provider downstream. v1
  // accepts a route param; route registration adds /:companyId/plans.
  const url = new URL(window.location.href);
  const companyId = url.pathname.split("/").filter(Boolean)[0] ?? "";

  const [status, setStatus] = useState<string>("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["plans-index", companyId, status],
    enabled: !!companyId,
    queryFn: () => listAllPlans(companyId, status || undefined),
  });

  if (!companyId)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open this page from inside a company context.
      </div>
    );
  if (isLoading) return <div className="p-4 text-sm">Loading…</div>;
  if (error)
    return <div className="p-4 text-sm text-destructive">Failed to load.</div>;

  const plans = data?.plans ?? [];

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Plans</h1>
        <select
          className="rounded border bg-transparent px-2 py-1 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {plans.length === 0 ? (
        <div className="text-sm text-muted-foreground">No plans match the filter.</div>
      ) : (
        <ul className="space-y-2">
          {plans.map((p) => (
            <PlanRowItem key={p.id} plan={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanRowItem({ plan }: { plan: PlanRow }) {
  return (
    <li className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-3">
        <a className="text-sm font-medium hover:underline" href={`/plans/${plan.id}`}>
          {plan.title}
        </a>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">
          {plan.status.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          rev {plan.currentRevisionNumber} · updated{" "}
          {new Date(plan.updatedAt).toLocaleDateString()}
        </span>
      </div>
    </li>
  );
}
