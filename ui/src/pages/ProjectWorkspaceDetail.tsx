import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { ArrowLeft, Check, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChoosePathButton } from "../components/PathInstructionsModal";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef, projectWorkspaceUrl } from "../lib/utils";

type WorkspaceFormState = {
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string;
  repoUrl: string;
  repoRef: string;
  defaultRef: string;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string;
  cleanupCommand: string;
  remoteProvider: string;
  remoteWorkspaceRef: string;
  sharedWorkspaceKey: string;
};

type ProjectWorkspaceSourceType = ProjectWorkspace["sourceType"];
type ProjectWorkspaceVisibility = ProjectWorkspace["visibility"];

const SOURCE_TYPE_OPTIONS: Array<{ value: ProjectWorkspaceSourceType; label: string; description: string }> = [
  { value: "local_path", label: "Local git checkout", description: "A local path Paperclip can use directly." },
  { value: "non_git_path", label: "Local non-git path", description: "A local folder without git semantics." },
  { value: "git_repo", label: "Remote git repo", description: "A repo URL with optional refs and local checkout." },
  { value: "remote_managed", label: "Remote-managed workspace", description: "A hosted workspace tracked by external reference." },
];

const VISIBILITY_OPTIONS: Array<{ value: ProjectWorkspaceVisibility; label: string }> = [
  { value: "default", label: "Default" },
  { value: "advanced", label: "Advanced" },
];

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsolutePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function readText(value: string | null | undefined) {
  return value ?? "";
}

function formStateFromWorkspace(workspace: ProjectWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    sourceType: workspace.sourceType,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    repoRef: readText(workspace.repoRef),
    defaultRef: readText(workspace.defaultRef),
    visibility: workspace.visibility,
    setupCommand: readText(workspace.setupCommand),
    cleanupCommand: readText(workspace.cleanupCommand),
    remoteProvider: readText(workspace.remoteProvider),
    remoteWorkspaceRef: readText(workspace.remoteWorkspaceRef),
    sharedWorkspaceKey: readText(workspace.sharedWorkspaceKey),
  };
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildWorkspacePatch(initialState: WorkspaceFormState, nextState: WorkspaceFormState) {
  const patch: Record<string, unknown> = {};
  const maybeAssign = (key: keyof WorkspaceFormState, transform?: (value: string) => unknown) => {
    const initialValue = initialState[key];
    const nextValue = nextState[key];
    if (initialValue === nextValue) return;
    patch[key] = transform ? transform(nextValue) : nextValue;
  };

  maybeAssign("name", normalizeText);
  maybeAssign("sourceType");
  maybeAssign("cwd", normalizeText);
  maybeAssign("repoUrl", normalizeText);
  maybeAssign("repoRef", normalizeText);
  maybeAssign("defaultRef", normalizeText);
  maybeAssign("visibility");
  maybeAssign("setupCommand", normalizeText);
  maybeAssign("cleanupCommand", normalizeText);
  maybeAssign("remoteProvider", normalizeText);
  maybeAssign("remoteWorkspaceRef", normalizeText);
  maybeAssign("sharedWorkspaceKey", normalizeText);

  return patch;
}

function validateWorkspaceForm(form: WorkspaceFormState) {
  const cwd = normalizeText(form.cwd);
  const repoUrl = normalizeText(form.repoUrl);
  const remoteWorkspaceRef = normalizeText(form.remoteWorkspaceRef);

  if (form.sourceType === "remote_managed") {
    if (!remoteWorkspaceRef && !repoUrl) {
      return "Remote-managed workspaces require a remote workspace ref or repo URL.";
    }
  } else if (!cwd && !repoUrl) {
    return "Workspace requires at least one local path or repo URL.";
  }

  if (cwd && (form.sourceType === "local_path" || form.sourceType === "non_git_path") && !isAbsolutePath(cwd)) {
    return "Local workspace path must be absolute.";
  }

  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return "Repo URL must be a valid URL.";
    }
  }

  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-28 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

export function ProjectWorkspaceDetail() {
  const { companyPrefix, projectId, workspaceId } = useParams<{
    companyPrefix?: string;
    projectId: string;
    workspaceId: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<WorkspaceFormState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const routeProjectRef = projectId ?? "";
  const routeWorkspaceId = workspaceId ?? "";

  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);

  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: routeProjectRef.length > 0,
  });

  const project = projectQuery.data ?? null;
  const workspace = useMemo(
    () => project?.workspaces.find((item) => item.id === routeWorkspaceId) ?? null,
    [project, routeWorkspaceId],
  );
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!workspace) return;
    setForm(formStateFromWorkspace(workspace));
    setErrorMessage(null);
  }, [workspace]);

  useEffect(() => {
    if (!project) return;
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project.name, href: `/projects/${canonicalProjectRef}` },
      { label: "Workspaces", href: `/projects/${canonicalProjectRef}/workspaces` },
      { label: workspace?.name ?? routeWorkspaceId },
    ]);
  }, [setBreadcrumbs, project, canonicalProjectRef, workspace?.name, routeWorkspaceId]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    navigate(projectWorkspaceUrl(project, routeWorkspaceId), { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, routeWorkspaceId, navigate]);

  const invalidateProject = () => {
    if (!project) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    if (lookupCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(lookupCompanyId) });
    }
  };

  const updateWorkspace = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      projectsApi.updateWorkspace(project!.id, routeWorkspaceId, patch, lookupCompanyId),
    onSuccess: () => {
      invalidateProject();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save workspace.");
    },
  });

  const setPrimaryWorkspace = useMutation({
    mutationFn: () => projectsApi.updateWorkspace(project!.id, routeWorkspaceId, { isPrimary: true }, lookupCompanyId),
    onSuccess: () => {
      invalidateProject();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update workspace.");
    },
  });

  if (projectQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (projectQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {projectQuery.error instanceof Error ? projectQuery.error.message : "Failed to load workspace"}
      </p>
    );
  }
  if (!project || !workspace || !form || !initialState) {
    return <p className="text-sm text-muted-foreground">Workspace not found for this project.</p>;
  }

  const saveChanges = () => {
    const validationError = validateWorkspaceForm(form);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    const patch = buildWorkspacePatch(initialState, form);
    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  const sourceTypeDescription = SOURCE_TYPE_OPTIONS.find((option) => option.value === form.sourceType)?.description ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/projects/${canonicalProjectRef}/workspaces`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to workspaces
          </Link>
        </Button>
        <div className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
          {workspace.isPrimary ? "Primary workspace" : "Secondary workspace"}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.9fr)]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Project workspace
                </div>
                <h1 className="text-2xl font-semibold">{workspace.name}</h1>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Configure the concrete workspace Paperclip attaches to this project. These values drive per-workspace
                  checkout behavior and let you override setup or cleanup commands when one workspace needs special handling.
                </p>
              </div>
              {!workspace.isPrimary ? (
                <Button
                  variant="outline"
                  disabled={setPrimaryWorkspace.isPending}
                  onClick={() => setPrimaryWorkspace.mutate()}
                >
                  {setPrimaryWorkspace.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Check className="mr-2 h-4 w-4" />}
                  Make primary
                </Button>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                  <Sparkles className="h-4 w-4" />
                  This is the project’s primary codebase workspace.
                </div>
              )}
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Workspace name">
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.name}
                  onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                  placeholder="Workspace name"
                />
              </Field>

              <Field label="Visibility">
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.visibility}
                  onChange={(event) =>
                    setForm((current) => current ? { ...current, visibility: event.target.value as ProjectWorkspaceVisibility } : current)
                  }
                >
                  {VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-4 grid gap-4">
              <Field label="Source type" hint={sourceTypeDescription ?? undefined}>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.sourceType}
                  onChange={(event) =>
                    setForm((current) => current ? { ...current, sourceType: event.target.value as ProjectWorkspaceSourceType } : current)
                  }
                >
                  {SOURCE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                <Field label="Local path">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cwd}
                    onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                    placeholder="/absolute/path/to/workspace"
                  />
                </Field>
                <div className="flex items-end">
                  <ChoosePathButton />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Repo URL">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.repoUrl}
                    onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                    placeholder="https://github.com/org/repo"
                  />
                </Field>
                <Field label="Repo ref">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.repoRef}
                    onChange={(event) => setForm((current) => current ? { ...current, repoRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Default ref">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.defaultRef}
                    onChange={(event) => setForm((current) => current ? { ...current, defaultRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
                <Field label="Shared workspace key">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.sharedWorkspaceKey}
                    onChange={(event) => setForm((current) => current ? { ...current, sharedWorkspaceKey: event.target.value } : current)}
                    placeholder="frontend"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Remote provider">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.remoteProvider}
                    onChange={(event) => setForm((current) => current ? { ...current, remoteProvider: event.target.value } : current)}
                    placeholder="codespaces"
                  />
                </Field>
                <Field label="Remote workspace ref">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.remoteWorkspaceRef}
                    onChange={(event) => setForm((current) => current ? { ...current, remoteWorkspaceRef: event.target.value } : current)}
                    placeholder="workspace-123"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Setup command" hint="Runs when this workspace needs custom bootstrap">
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.setupCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, setupCommand: event.target.value } : current)}
                    placeholder="pnpm install && pnpm dev"
                  />
                </Field>
                <Field label="Cleanup command" hint="Runs before project-level execution workspace teardown">
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cleanupCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                    placeholder="pkill -f vite || true"
                  />
                </Field>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
              <Button
                variant="outline"
                disabled={!isDirty || updateWorkspace.isPending}
                onClick={() => {
                  setForm(initialState);
                  setErrorMessage(null);
                }}
              >
                Reset
              </Button>
              {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
              {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">No unsaved changes.</p> : null}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspace facts</div>
              <h2 className="text-lg font-semibold">Current state</h2>
            </div>
            <Separator className="my-4" />
            <DetailRow label="Project">
              <Link to={`/projects/${canonicalProjectRef}`} className="hover:underline">{project.name}</Link>
            </DetailRow>
            <DetailRow label="Workspace ID">
              <span className="break-all font-mono text-xs">{workspace.id}</span>
            </DetailRow>
            <DetailRow label="Local path">
              <span className="break-all font-mono text-xs">{workspace.cwd ?? "None"}</span>
            </DetailRow>
            <DetailRow label="Repo">
              {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {workspace.repoUrl}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : workspace.repoUrl ? (
                <span className="break-all font-mono text-xs">{workspace.repoUrl}</span>
              ) : "None"}
            </DetailRow>
            <DetailRow label="Default ref">{workspace.defaultRef ?? "None"}</DetailRow>
            <DetailRow label="Updated">{new Date(workspace.updatedAt).toLocaleString()}</DetailRow>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Runtime services</div>
              <h2 className="text-lg font-semibold">Attached services</h2>
            </div>
            <Separator className="my-4" />
            {workspace.runtimeServices && workspace.runtimeServices.length > 0 ? (
              <div className="space-y-3">
                {workspace.runtimeServices.map((service) => (
                  <div key={service.id} className="rounded-xl border border-border/80 bg-background px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{service.serviceName}</div>
                        <div className="text-xs text-muted-foreground">
                          {service.url ? (
                            <a href={service.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {service.url}
                            </a>
                          ) : (
                            service.command ?? "No command recorded"
                          )}
                        </div>
                      </div>
                      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                        {service.status}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No runtime services are attached to this workspace.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
