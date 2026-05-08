// Plan 5: instance-admin admin page for the distributed worker
// fleet. Read-only fleet view + per-worker Drain button. Polls the
// /api/_workers endpoint every 5s. Intentionally minimal styling —
// admin surface, not a customer-facing page; iteration on visual
// polish lives in a follow-up.

import { useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _useBreadcrumbsRef = useBreadcrumbs; // imported for the side-effect of pulling the context provider through; setBreadcrumbs not called directly here.

interface WorkerSnapshot {
  workerId: string;
  instanceId: string;
  adapters: string[];
  maxConcurrent: number;
  inFlight: number;
  draining: boolean;
}

interface WorkersSummary {
  totalConnected: number;
  totalCapacity: number;
  inflightRuns: number;
  draining: number;
}

interface WorkersResponse {
  workers: WorkerSnapshot[];
  summary: WorkersSummary;
}

const POLL_MS = 5_000;

async function fetchWorkers(): Promise<WorkersResponse> {
  const res = await fetch("/api/_workers", { credentials: "include" });
  if (!res.ok) throw new Error(`workers fetch failed: ${res.status}`);
  return res.json();
}

async function drainWorker(workerId: string): Promise<void> {
  const res = await fetch(`/api/_workers/${encodeURIComponent(workerId)}/drain`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`drain failed: ${res.status}`);
}

export function InstanceWorkers() {
  const [data, setData] = useState<WorkersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draining, setDraining] = useState<Set<string>>(new Set());

  // breadcrumbs are managed by the layout; this page is intentionally
  // unbreadcrumbed (admin operational surface, not a customer-facing
  // navigation path).

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchWorkers();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onDrain = async (workerId: string) => {
    setDraining((s) => new Set(s).add(workerId));
    try {
      await drainWorker(workerId);
    } finally {
      // Leave the row marked draining locally; the next poll will pick
      // up the registry's own draining flag, which is the source of
      // truth.
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>Workers</h1>
      {error && (
        <div style={{ color: "red", marginTop: 8 }}>Error: {error}</div>
      )}
      {data && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#555" }}>
          Connected: {data.summary.totalConnected} · Capacity:{" "}
          {data.summary.totalCapacity} · In-flight: {data.summary.inflightRuns} ·
          Draining: {data.summary.draining}
        </div>
      )}
      <table style={{ marginTop: 16, borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "6px 8px" }}>Worker</th>
            <th style={{ padding: "6px 8px" }}>Instance</th>
            <th style={{ padding: "6px 8px" }}>Adapters</th>
            <th style={{ padding: "6px 8px" }}>In-flight / Max</th>
            <th style={{ padding: "6px 8px" }}>Draining</th>
            <th style={{ padding: "6px 8px" }}></th>
          </tr>
        </thead>
        <tbody>
          {(data?.workers ?? []).map((w) => (
            <tr key={w.workerId} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{w.workerId}</td>
              <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{w.instanceId}</td>
              <td style={{ padding: "6px 8px" }}>{w.adapters.join(", ")}</td>
              <td style={{ padding: "6px 8px" }}>{w.inFlight} / {w.maxConcurrent}</td>
              <td style={{ padding: "6px 8px" }}>{w.draining ? "yes" : "no"}</td>
              <td style={{ padding: "6px 8px" }}>
                <button
                  type="button"
                  disabled={w.draining || draining.has(w.workerId)}
                  onClick={() => void onDrain(w.workerId)}
                  style={{ padding: "4px 10px" }}
                >
                  Drain
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.workers.length === 0 && (
        <div style={{ marginTop: 16, color: "#888" }}>No workers connected.</div>
      )}
    </div>
  );
}

export default InstanceWorkers;
