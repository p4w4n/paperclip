import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listPlanReviews, submitReview } from "@/api/plans";

interface ReviewSurfaceProps {
  planId: string;
  // Whether the caller is allowed to submit a review per the plan's
  // approval_policy. Calling code derives this from the user's role
  // / agent role.
  canReview: boolean;
}

export function ReviewSurface({ planId, canReview }: ReviewSurfaceProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const reviewsQ = useQuery({
    queryKey: ["plan-reviews", planId],
    queryFn: () => listPlanReviews(planId),
  });

  const mutation = useMutation({
    mutationFn: async (decision: "approved" | "requested_changes" | "rejected") => {
      setBusy(true);
      try {
        await submitReview(planId, { decision, comment: comment || undefined });
      } finally {
        setBusy(false);
      }
    },
    onSuccess: () => {
      setComment("");
      void queryClient.invalidateQueries({ queryKey: ["plan", planId] });
      void queryClient.invalidateQueries({ queryKey: ["plan-reviews", planId] });
    },
  });

  const reviews = reviewsQ.data?.reviews ?? [];

  return (
    <div className="space-y-3">
      {canReview ? (
        <div className="space-y-2 rounded-md border bg-card p-3">
          <textarea
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full resize-y rounded border bg-transparent p-2 text-sm"
            rows={3}
          />
          <div className="flex gap-2">
            <button
              className="rounded bg-green-600 px-3 py-1 text-xs text-white disabled:opacity-50"
              onClick={() => mutation.mutate("approved")}
              disabled={busy}
            >
              Approve
            </button>
            <button
              className="rounded bg-amber-500 px-3 py-1 text-xs text-white disabled:opacity-50"
              onClick={() => mutation.mutate("requested_changes")}
              disabled={busy}
            >
              Request changes
            </button>
            <button
              className="rounded bg-red-600 px-3 py-1 text-xs text-white disabled:opacity-50"
              onClick={() => mutation.mutate("rejected")}
              disabled={busy}
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}
      {reviews.length === 0 ? (
        <div className="text-sm text-muted-foreground">No reviews yet.</div>
      ) : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-md border bg-card p-3 text-xs">
              <div className="flex items-center gap-2">
                <DecisionBadge decision={r.decision} />
                <span className="text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
              {r.commentMarkdown ? (
                <p className="mt-1 text-muted-foreground">{r.commentMarkdown}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const color =
    decision === "approved"
      ? "bg-green-100 text-green-700"
      : decision === "rejected"
        ? "bg-red-100 text-red-700"
        : "bg-amber-100 text-amber-700";
  return (
    <span className={`rounded px-2 py-0.5 font-medium ${color}`}>
      {decision.replace(/_/g, " ")}
    </span>
  );
}
