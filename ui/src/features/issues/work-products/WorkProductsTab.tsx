import { useQuery } from "@tanstack/react-query";
import {
  Code,
  FileText,
  GitCommit,
  Image,
  LayoutDashboard,
  Table as TableIcon,
} from "lucide-react";
import { listArtifactsForIssue, type ArtifactRow } from "@/api/artifacts";

const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "code.file": Code,
  "code.patch": GitCommit,
  "doc.markdown": FileText,
  "doc.office": FileText,
  chart: Image,
  "data.table": TableIcon,
  "web.app": LayoutDashboard,
};

interface WorkProductsTabProps {
  issueId: string;
}

export function WorkProductsTab({ issueId }: WorkProductsTabProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["issue-artifacts", issueId],
    queryFn: () => listArtifactsForIssue(issueId),
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load work products.
      </div>
    );
  }
  const artifacts = data?.artifacts ?? [];
  if (artifacts.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No work products yet. Agent-declared outputs will appear here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => (
        <ArtifactRowItem key={artifact.id} artifact={artifact} />
      ))}
    </div>
  );
}

function ArtifactRowItem({ artifact }: { artifact: ArtifactRow }) {
  const Icon = KIND_ICONS[artifact.kind] ?? FileText;
  const previewActive =
    artifact.previewUrl &&
    (!artifact.previewExpiresAt || new Date(artifact.previewExpiresAt) > new Date());
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card p-3">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium truncate">
          <code className="text-xs font-mono">{artifact.name}</code>
          <span className="text-xs text-muted-foreground">{artifact.kind}</span>
          {artifact.parentId ? (
            <span className="text-xs text-muted-foreground">(revised)</span>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(artifact.declaredAt).toLocaleString()} • {formatBytes(artifact.blobBytes)}
        </div>
      </div>
      {previewActive && artifact.previewUrl ? (
        <a
          href={artifact.previewUrl}
          className="text-xs text-primary underline hover:no-underline"
          rel="noreferrer"
          target="_blank"
        >
          Preview
        </a>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
