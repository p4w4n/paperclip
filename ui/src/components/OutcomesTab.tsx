import { useEffect, useState, useCallback } from "react";
import { listOutcomes, signOff, revertOutcome, type OutcomeRowDto } from "../api/outcomes";

export interface OutcomesTabProps {
  target: { kind: "issue" | "plan"; id: string; companyId: string };
  onPendingCountChange?: (n: number) => void;
}

export function OutcomesTab({ target, onPendingCountChange }: OutcomesTabProps) {
  const [rows, setRows] = useState<OutcomeRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listOutcomes(target);
      setRows(list);
      onPendingCountChange?.(list.filter((r) => r.status === "pending").length);
    } catch (e) {
      setError(String(e));
    }
  }, [target.id, target.kind, target.companyId, onPendingCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error)
    return <div className="p-4 text-sm text-destructive">{error}</div>;
  if (!rows)
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (rows.length === 0)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No outcomes required for this {target.kind}.
      </div>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <th className="py-2 pr-4 text-left font-medium">Kind</th>
            <th className="py-2 pr-4 text-left font-medium">Name</th>
            <th className="py-2 pr-4 text-left font-medium">Status</th>
            <th className="py-2 pr-4 text-left font-medium">Evidence</th>
            <th className="py-2 text-left font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.id} className="group">
              <td className="py-2 pr-4 font-mono text-xs">{r.kind}</td>
              <td className="py-2 pr-4">{String(r.requiredMeta.name ?? "")}</td>
              <td className="py-2 pr-4">
                <StatusPill status={r.status} />
              </td>
              <td className="py-2 pr-4">
                <EvidenceLink row={r} />
              </td>
              <td className="py-2 space-x-2">
                {r.status === "pending" && r.kind === "manual_signoff" && (
                  <button
                    className="text-xs text-primary underline disabled:opacity-50 hover:no-underline"
                    onClick={async () => {
                      await signOff(target.companyId, r.id);
                      void refresh();
                    }}
                  >
                    Sign off
                  </button>
                )}
                {r.status === "verified" && (
                  <button
                    className="text-xs text-destructive underline disabled:opacity-50 hover:no-underline"
                    onClick={async () => {
                      const reason = prompt("Reason for revert?");
                      if (reason) {
                        await revertOutcome(target.companyId, r.id, reason);
                        void refresh();
                      }
                    }}
                  >
                    Withdraw
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colorClass =
    status === "verified"
      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
      : status === "reverted"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
        : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {status}
    </span>
  );
}

function EvidenceLink({ row }: { row: OutcomeRowDto }) {
  if (row.status !== "verified" || !row.verifiedMeta) return null;
  if (
    row.kind === "artifact_declared" &&
    typeof row.verifiedMeta.artifact_id === "string"
  ) {
    return (
      <a
        href={`/artifacts/${row.verifiedMeta.artifact_id}`}
        className="text-xs text-primary underline hover:no-underline"
      >
        artifact
      </a>
    );
  }
  if (
    row.kind === "plan_completed" &&
    typeof row.verifiedMeta.plan_id === "string"
  ) {
    return (
      <a
        href={`/plans/${row.verifiedMeta.plan_id}`}
        className="text-xs text-primary underline hover:no-underline"
      >
        plan
      </a>
    );
  }
  if (
    row.kind === "approval_granted" &&
    typeof row.verifiedMeta.approval_id === "string"
  ) {
    return (
      <a
        href={`/approvals/${row.verifiedMeta.approval_id}`}
        className="text-xs text-primary underline hover:no-underline"
      >
        approval
      </a>
    );
  }
  return null;
}
