import type { PlanPhaseRow } from "@/api/plans";
import { CheckCircle, Circle, CircleAlert, Loader2 } from "lucide-react";

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Circle,
  ready: Circle,
  in_progress: Loader2,
  completed: CheckCircle,
  skipped: Circle,
  blocked: CircleAlert,
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  ready: "Ready",
  in_progress: "In progress",
  completed: "Completed",
  skipped: "Skipped",
  blocked: "Blocked",
};

interface PhaseTreeProps {
  phases: PlanPhaseRow[];
  onStart?: (phaseId: string) => void;
  onComplete?: (phaseId: string) => void;
  busy?: string | null;
}

export function PhaseTree({ phases, onStart, onComplete, busy }: PhaseTreeProps) {
  if (phases.length === 0) {
    return <div className="text-sm text-muted-foreground">No phases.</div>;
  }
  const sorted = [...phases].sort((a, b) => a.ordering - b.ordering);
  return (
    <ol className="space-y-2">
      {sorted.map((p) => {
        const Icon = STATUS_ICONS[p.status] ?? Circle;
        return (
          <li
            key={p.id}
            className="flex items-start gap-3 rounded-md border bg-card p-3"
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${p.status === "completed" ? "text-green-600" : p.status === "blocked" ? "text-amber-600" : "text-muted-foreground"}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {STATUS_LABELS[p.status] ?? p.status}
                </span>
              </div>
              {p.descriptionMarkdown ? (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-3">
                  {p.descriptionMarkdown}
                </p>
              ) : null}
            </div>
            <div className="shrink-0 space-x-2">
              {p.status === "ready" && onStart ? (
                <button
                  className="text-xs text-primary underline disabled:opacity-50"
                  onClick={() => onStart(p.id)}
                  disabled={busy === p.id}
                >
                  Start
                </button>
              ) : null}
              {p.status === "in_progress" && onComplete ? (
                <button
                  className="text-xs text-primary underline disabled:opacity-50"
                  onClick={() => onComplete(p.id)}
                  disabled={busy === p.id}
                >
                  Complete
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
