// /admin/learning curation surface. Per company:
//   - proposed playbooks (Approve / Archive)
//   - active playbooks (Archive)
//   - outcome patterns awaiting promotion
//   - decision patterns

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approvePlaybook,
  archivePlaybook,
  listDecisionPatterns,
  listOutcomePatterns,
  listPlaybooks,
  type OutcomePatternRow,
  type PlaybookRow,
} from "@/api/learning";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

export function AdminLearning() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Learning" }]), [setBreadcrumbs]);

  const url = new URL(window.location.href);
  const companyId = url.pathname.split("/").filter(Boolean)[0] ?? "";
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const proposedQ = useQuery({
    queryKey: ["learning-proposed", companyId],
    queryFn: () => listPlaybooks(companyId, { status: "proposed" }),
    enabled: !!companyId,
  });
  const activeQ = useQuery({
    queryKey: ["learning-active", companyId],
    queryFn: () => listPlaybooks(companyId, { status: "active" }),
    enabled: !!companyId,
  });
  const patternsQ = useQuery({
    queryKey: ["learning-patterns", companyId],
    queryFn: () => listOutcomePatterns(companyId),
    enabled: !!companyId,
  });
  const decisionsQ = useQuery({
    queryKey: ["learning-decisions", companyId],
    queryFn: () => listDecisionPatterns(companyId),
    enabled: !!companyId,
  });

  const reload = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["learning-proposed", companyId] }),
      queryClient.invalidateQueries({ queryKey: ["learning-active", companyId] }),
      queryClient.invalidateQueries({ queryKey: ["learning-patterns", companyId] }),
    ]);
  };

  const onApprove = async (pb: PlaybookRow) => {
    setBusy(pb.id);
    try {
      await approvePlaybook(pb.id);
      await reload();
    } finally {
      setBusy(null);
    }
  };
  const onArchive = async (pb: PlaybookRow) => {
    setBusy(pb.id);
    try {
      await archivePlaybook(pb.id);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  if (!companyId)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open this page from inside a company context.
      </div>
    );

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">Organizational learning</h1>

      <Section title="Proposed playbooks" loading={proposedQ.isLoading}>
        {(proposedQ.data?.playbooks ?? []).length === 0 ? (
          <Empty>No mined playbooks awaiting review.</Empty>
        ) : (
          <ul className="space-y-2">
            {(proposedQ.data?.playbooks ?? []).map((pb) => (
              <PlaybookCard
                key={pb.id}
                playbook={pb}
                busy={busy === pb.id}
                onApprove={() => onApprove(pb)}
                onArchive={() => onArchive(pb)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Active playbooks" loading={activeQ.isLoading}>
        {(activeQ.data?.playbooks ?? []).length === 0 ? (
          <Empty>No active playbooks yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {(activeQ.data?.playbooks ?? []).map((pb) => (
              <PlaybookCard
                key={pb.id}
                playbook={pb}
                busy={busy === pb.id}
                onArchive={() => onArchive(pb)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Outcome patterns" loading={patternsQ.isLoading}>
        {(patternsQ.data?.patterns ?? []).length === 0 ? (
          <Empty>No mined patterns yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {(patternsQ.data?.patterns ?? []).map((p) => (
              <PatternCard key={p.id} pattern={p} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decision patterns" loading={decisionsQ.isLoading}>
        {(decisionsQ.data?.patterns ?? []).length === 0 ? (
          <Empty>No decision patterns aggregated yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {(decisionsQ.data?.patterns ?? []).map((p) => (
              <li key={p.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="font-medium">{p.conditionSummary}</div>
                <div className="text-xs text-muted-foreground">
                  Typical choice: <span className="font-medium text-foreground">{p.typicalChoice}</span>{" "}
                  · {p.clusterSize} examples · confidence {(p.confidence * 100).toFixed(0)}%
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  loading,
  children,
}: {
  title: string;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {loading ? <div className="text-sm">Loading…</div> : children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-muted-foreground">{children}</div>;
}

function PlaybookCard({
  playbook,
  busy,
  onApprove,
  onArchive,
}: {
  playbook: PlaybookRow;
  busy: boolean;
  onApprove?: () => void;
  onArchive?: () => void;
}) {
  return (
    <li className="rounded-md border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {playbook.title}
            <span className="rounded bg-muted px-2 py-0.5 text-xs">
              {playbook.status}
            </span>
            <span className="text-xs text-muted-foreground">
              confidence {(playbook.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            slug: <code>{playbook.slug}</code> · rev {playbook.currentRevisionNumber}
          </div>
        </div>
        <div className="space-x-2">
          {onApprove ? (
            <button
              className="text-xs text-green-600 underline disabled:opacity-50"
              onClick={onApprove}
              disabled={busy}
            >
              Approve
            </button>
          ) : null}
          {onArchive ? (
            <button
              className="text-xs text-destructive underline disabled:opacity-50"
              onClick={onArchive}
              disabled={busy}
            >
              Archive
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function PatternCard({ pattern }: { pattern: OutcomePatternRow }) {
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <div className="font-medium">{pattern.patternDescription ?? pattern.patternName}</div>
      <div className="text-xs text-muted-foreground">
        {pattern.clusterSize} runs · confidence {(pattern.confidence * 100).toFixed(0)}%
        {pattern.promotedToPlaybookId ? " · promoted" : " · pending review"}
      </div>
    </li>
  );
}
