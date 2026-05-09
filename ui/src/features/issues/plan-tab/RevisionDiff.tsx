import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listPlanRevisions, type PlanRevisionRow } from "@/api/plans";

interface RevisionDiffProps {
  planId: string;
}

export function RevisionDiff({ planId }: RevisionDiffProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["plan-revisions", planId],
    queryFn: () => listPlanRevisions(planId),
  });

  const revisions = data?.revisions ?? [];
  const [prevId, setPrevId] = useState<string>("");
  const [nextId, setNextId] = useState<string>("");

  const prev = revisions.find((r) => r.id === prevId);
  const next = revisions.find((r) => r.id === nextId);

  const diff = useMemo(() => {
    if (!next) return "";
    return naiveDiff(prev?.contentMarkdown ?? "", next.contentMarkdown);
  }, [prev, next]);

  if (isLoading) return <div className="text-sm">Loading…</div>;
  if (revisions.length === 0)
    return <div className="text-sm text-muted-foreground">No revisions.</div>;

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-xs">
        <RevPicker
          label="From"
          value={prevId}
          onChange={setPrevId}
          revisions={revisions}
        />
        <RevPicker
          label="To"
          value={nextId}
          onChange={setNextId}
          revisions={revisions}
        />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-card p-3 text-xs leading-tight">
        {diff || "Pick two revisions to compare."}
      </pre>
    </div>
  );
}

function RevPicker({
  label,
  value,
  onChange,
  revisions,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  revisions: PlanRevisionRow[];
}) {
  return (
    <label className="flex items-center gap-1 text-muted-foreground">
      {label}:{" "}
      <select
        className="rounded border bg-transparent px-2 py-0.5 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {revisions.map((r) => (
          <option key={r.id} value={r.id}>
            rev {r.revisionNumber}
          </option>
        ))}
      </select>
    </label>
  );
}

function naiveDiff(prev: string, next: string): string {
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const out: string[] = [];
  const max = Math.max(prevLines.length, nextLines.length);
  for (let i = 0; i < max; i++) {
    const a = prevLines[i];
    const b = nextLines[i];
    if (a === b) {
      if (a !== undefined) out.push(`  ${a}`);
      continue;
    }
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.join("\n");
}
