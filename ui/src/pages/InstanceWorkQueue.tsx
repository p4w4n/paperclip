// Instance-admin page for the work queue. Three sections: per-
// (company, queue) depth, dead-letter inspector, replay/cancel
// buttons per row. Polls /admin/work-queue every 5s — same shape
// as InstanceWorkers.

import { useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import {
  cancelWorkItem,
  listAdminWorkQueue,
  replayDeadLetter,
  type AdminWorkQueueResponse,
  type WorkItemSummary,
} from "@/api/work-queue";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ref = useBreadcrumbs;

export function InstanceWorkQueue() {
  const [data, setData] = useState<AdminWorkQueueResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const d = await listAdminWorkQueue();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, []);

  const onReplay = async (item: WorkItemSummary) => {
    setBusy(item.id);
    try {
      await replayDeadLetter(item.id);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const onCancel = async (item: WorkItemSummary) => {
    setBusy(item.id);
    try {
      await cancelWorkItem(item.id);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">Work queue</h1>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Depth
        </h2>
        {!data ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : data.depth.length === 0 ? (
          <div className="text-sm text-muted-foreground">No queued items.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-1">Company</th>
                <th>Queue</th>
                <th>Depth</th>
              </tr>
            </thead>
            <tbody>
              {data.depth.map((d) => (
                <tr key={`${d.companyId}/${d.queue}`} className="border-t">
                  <td className="py-1 font-mono text-xs">{d.companyId}</td>
                  <td>{d.queue}</td>
                  <td>{d.depth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Dead letter
        </h2>
        {!data ? null : data.deadLetter.length === 0 ? (
          <div className="text-sm text-muted-foreground">Empty.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th>Item</th>
                <th>Queue</th>
                <th>Attempts</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.deadLetter.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="py-1 font-mono text-xs">{item.id.slice(0, 8)}…</td>
                  <td>{item.queue}</td>
                  <td>
                    {item.attempts} / {item.maxAttempts}
                  </td>
                  <td className="max-w-md truncate text-xs text-muted-foreground" title={item.lastError ?? ""}>
                    {item.lastErrorCode ?? "-"}
                  </td>
                  <td className="text-right">
                    <button
                      className="mr-2 text-xs text-primary underline disabled:opacity-50"
                      onClick={() => onReplay(item)}
                      disabled={busy === item.id}
                    >
                      Replay
                    </button>
                    <button
                      className="text-xs text-destructive underline disabled:opacity-50"
                      onClick={() => onCancel(item)}
                      disabled={busy === item.id}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
