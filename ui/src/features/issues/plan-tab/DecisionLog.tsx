import { useQuery } from "@tanstack/react-query";
import { listPlanDecisions } from "@/api/plans";

interface DecisionLogProps {
  planId: string;
}

export function DecisionLog({ planId }: DecisionLogProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["plan-decisions", planId],
    queryFn: () => listPlanDecisions(planId),
  });
  if (isLoading) return <div className="text-sm">Loading…</div>;
  const rows = data?.decisions ?? [];
  if (rows.length === 0)
    return <div className="text-sm text-muted-foreground">No decisions yet.</div>;
  return (
    <ul className="space-y-2">
      {rows.map((d) => {
        const chosen = d.optionsJson.find((o) => o.id === d.chosenOptionId);
        return (
          <li key={d.id} className="rounded-md border bg-card p-3">
            <div className="text-sm font-medium">{d.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Chose{" "}
              <span className="font-medium text-foreground">
                {chosen?.label ?? d.chosenOptionId}
              </span>{" "}
              from {d.optionsJson.map((o) => o.label).join(" / ")}
            </div>
            {d.rationaleMarkdown ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {d.rationaleMarkdown}
              </p>
            ) : null}
            <div className="mt-1 text-[10px] text-muted-foreground">
              {new Date(d.decidedAt).toLocaleString()}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
