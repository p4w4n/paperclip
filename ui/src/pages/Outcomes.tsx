// Instance-admin page for outcomes across all companies.
// GET /api/instance/outcomes — returns { outcomes: AdminOutcomeRow[] }

import { useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ref = useBreadcrumbs;

interface AdminOutcomeRow {
  id: string;
  companyId: string;
  targetKind: string;
  targetId: string;
  kind: string;
  status: string;
  verifiedAt?: string | null;
}

export function Outcomes() {
  const [rows, setRows] = useState<AdminOutcomeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/instance/outcomes")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ outcomes: AdminOutcomeRow[] }>;
      })
      .then((j) => setRows(j.outcomes))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="p-4 text-sm text-destructive">{error}</div>;

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">Outcomes (instance-wide)</h1>

      {!rows ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No outcomes recorded yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-1">Company</th>
              <th>Target</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Verified at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1 font-mono text-xs">{r.companyId.slice(0, 8)}</td>
                <td className="font-mono text-xs">
                  {r.targetKind}/{r.targetId.slice(0, 8)}
                </td>
                <td>{r.kind}</td>
                <td>{r.status}</td>
                <td className="text-muted-foreground">
                  {r.verifiedAt ? new Date(r.verifiedAt).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
