import { useEffect, useState, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { listOutcomes, signOff, revertOutcome, type OutcomeRowDto } from "../api/outcomes";

// Extended DTO shape returned by EO-P2-16 list endpoint.
// The server always returns these fields; fall back to sensible defaults when absent
// (e.g. in tests or older server versions).
interface OutcomeRowDtoExtended extends OutcomeRowDto {
  slot_base_name?: string;
  slot_satisfied?: boolean;
  alternatives?: OutcomeRowDto[];
}

export interface OutcomesTabProps {
  target: { kind: "issue" | "plan"; id: string; companyId: string };
  onPendingCountChange?: (n: number) => void;
}

// Derive the "base name" of a row: everything before the first `:alt:` suffix.
function baseName(name: string): string {
  const idx = name.indexOf(":alt:");
  return idx === -1 ? name : name.slice(0, idx);
}

// Returns true if the row is a primary row (name === slot_base_name).
function isPrimary(r: OutcomeRowDtoExtended): boolean {
  const rowName = String(r.requiredMeta.name ?? "");
  const slotBase = r.slot_base_name ?? baseName(rowName);
  return rowName === slotBase;
}

export function OutcomesTab({ target, onPendingCountChange }: OutcomesTabProps) {
  const [rows, setRows] = useState<OutcomeRowDtoExtended[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = (await listOutcomes(target)) as OutcomeRowDtoExtended[];
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

  // Split into primary rows (rendered at top level) and alt rows (rendered nested).
  // Alt rows whose slot_base_name row we can find are skipped here since they're
  // shown inside the primary row's collapsed section.
  const altIds = new Set(
    rows.flatMap((r) => (r.alternatives ?? []).map((a) => a.id)),
  );
  const topLevel = rows.filter((r) => !altIds.has(r.id) || isPrimary(r));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <th className="py-2 pr-4 text-left font-medium w-6"></th>
            <th className="py-2 pr-4 text-left font-medium">Kind</th>
            <th className="py-2 pr-4 text-left font-medium">Name</th>
            <th className="py-2 pr-4 text-left font-medium">Status</th>
            <th className="py-2 pr-4 text-left font-medium">Evidence</th>
            <th className="py-2 text-left font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {topLevel.map((r) => (
            <OutcomeRow
              key={r.id}
              row={r}
              target={target}
              onRefresh={refresh}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutcomeRow({
  row,
  target,
  onRefresh,
  nested = false,
}: {
  row: OutcomeRowDtoExtended;
  target: { kind: "issue" | "plan"; id: string; companyId: string };
  onRefresh: () => void;
  nested?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const alts = (row.alternatives ?? []) as OutcomeRowDtoExtended[];
  const hasAlts = alts.length > 0;
  const autoReopen = row.requiredMeta.auto_reopen_on_revert === true;

  return (
    <>
      <tr className={`group ${nested ? "bg-muted/20" : ""}`}>
        {/* Expand toggle cell */}
        <td className="py-2 pr-1 w-6">
          {hasAlts && (
            <button
              aria-expanded={expanded}
              data-testid={`alias-group-toggle-${String(row.requiredMeta.name ?? "")}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </td>

        {/* Kind */}
        <td className="py-2 pr-4 font-mono text-xs">{row.kind}</td>

        {/* Name + badges */}
        <td className="py-2 pr-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {nested && (
              <span className="text-muted-foreground text-xs">↳</span>
            )}
            <span>{String(row.requiredMeta.name ?? "")}</span>
            {hasAlts && (
              <button
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center rounded-full border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                title="This slot can be satisfied by any of the listed alternatives"
              >
                🔀 any-of
              </button>
            )}
            {autoReopen && (
              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                🔁 reopens-on-revert
              </span>
            )}
          </div>
        </td>

        {/* Status */}
        <td className="py-2 pr-4">
          <StatusPill status={row.status} />
        </td>

        {/* Evidence */}
        <td className="py-2 pr-4">
          <EvidenceLink row={row} />
        </td>

        {/* Actions */}
        <td className="py-2 space-x-2">
          {row.status === "pending" && row.kind === "manual_signoff" && (
            <button
              className="text-xs text-primary underline disabled:opacity-50 hover:no-underline"
              onClick={async () => {
                await signOff(target.companyId, row.id);
                void onRefresh();
              }}
            >
              Sign off
            </button>
          )}
          {row.status === "verified" && (
            <button
              className="text-xs text-destructive underline disabled:opacity-50 hover:no-underline"
              onClick={async () => {
                const reason = prompt("Reason for revert?");
                if (reason) {
                  await revertOutcome(target.companyId, row.id, reason);
                  void onRefresh();
                }
              }}
            >
              Withdraw
            </button>
          )}
        </td>
      </tr>

      {/* Alt rows (shown when expanded) */}
      {expanded &&
        alts.map((alt) => (
          <OutcomeRow
            key={alt.id}
            row={alt as OutcomeRowDtoExtended}
            target={target}
            onRefresh={onRefresh}
            nested
          />
        ))}
    </>
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
