import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { ChevronDown, ChevronRight, Clock3, Play, Plus, Repeat, Webhook } from "lucide-react";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "../lib/timeAgo";

const priorities = ["critical", "high", "medium", "low"];
const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows with a capped backlog after recovery.",
};

function triggerIcon(kind: string) {
  if (kind === "schedule") return <Clock3 className="h-3.5 w-3.5" />;
  if (kind === "webhook") return <Webhook className="h-3.5 w-3.5" />;
  return <Play className="h-3.5 w-3.5" />;
}

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Routines" }]);
  }, [setBreadcrumbs]);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!isLoading && (routines?.length ?? 0) === 0) {
      setComposerOpen(true);
    }
  }, [isLoading, routines]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const createRoutine = useMutation({
    mutationFn: () =>
      routinesApi.create(selectedCompanyId!, {
        ...draft,
        description: draft.description.trim() || null,
      }),
    onSuccess: async (routine) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
        assigneeAgentId: "",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });
      setComposerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) });
      pushToast({
        title: "Routine created",
        body: "Add the first trigger to turn it into a live workflow.",
        tone: "success",
      });
      navigate(`/routines/${routine.id}?tab=triggers`);
    },
  });

  const runRoutine = useMutation({
    mutationFn: (id: string) => routinesApi.run(id),
    onMutate: (id) => {
      setRunningRoutineId(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) });
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: mutationError instanceof Error ? mutationError.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const agentName = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectName = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
          <p className="text-sm text-muted-foreground">
            Define recurring work once, then let Paperclip materialize each execution as an auditable issue.
          </p>
        </div>
        <Button
          onClick={() => setComposerOpen((open) => !open)}
          variant={composerOpen ? "outline" : "default"}
        >
          <Plus className="mr-2 h-4 w-4" />
          {composerOpen ? "Hide composer" : "Create routine"}
        </Button>
      </div>

      {composerOpen ? (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">New routine</p>
              <p className="text-sm text-muted-foreground">
                Define the recurring work first. Trigger setup comes next on the detail page.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setComposerOpen(false);
                setAdvancedOpen(false);
              }}
              disabled={createRoutine.isPending}
            >
              Cancel
            </Button>
          </div>

          <div className="px-5 pt-5 pb-3">
            <textarea
              ref={titleInputRef}
              className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/50"
              placeholder="Routine title"
              rows={1}
              value={draft.title}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
                autoResizeTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  descriptionEditorRef.current?.focus();
                  return;
                }
                if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  if (draft.assigneeAgentId) {
                    if (draft.projectId) {
                      descriptionEditorRef.current?.focus();
                    } else {
                      projectSelectorRef.current?.focus();
                    }
                  } else {
                    assigneeSelectorRef.current?.focus();
                  }
                }
              }}
              autoFocus
            />
          </div>

          <div className="px-5 pb-3">
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                <span>For</span>
                <InlineEntitySelector
                  ref={assigneeSelectorRef}
                  value={draft.assigneeAgentId}
                  options={assigneeOptions}
                  placeholder="Assignee"
                  noneLabel="No assignee"
                  searchPlaceholder="Search assignees..."
                  emptyMessage="No assignees found."
                  onChange={(assigneeAgentId) => {
                    if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                    setDraft((current) => ({ ...current, assigneeAgentId }));
                  }}
                  onConfirm={() => {
                    if (draft.projectId) {
                      descriptionEditorRef.current?.focus();
                    } else {
                      projectSelectorRef.current?.focus();
                    }
                  }}
                  renderTriggerValue={(option) =>
                    option ? (
                      currentAssignee ? (
                        <>
                          <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="truncate">{option.label}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Assignee</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const assignee = agentById.get(option.id);
                    return (
                      <>
                        {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
                <span>in</span>
                <InlineEntitySelector
                  ref={projectSelectorRef}
                  value={draft.projectId}
                  options={projectOptions}
                  placeholder="Project"
                  noneLabel="No project"
                  searchPlaceholder="Search projects..."
                  emptyMessage="No projects found."
                  onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                  onConfirm={() => descriptionEditorRef.current?.focus()}
                  renderTriggerValue={(option) =>
                    option && currentProject ? (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Project</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const project = projectById.get(option.id);
                    return (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: project?.color ?? "#64748b" }}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-border/60 px-5 py-4">
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={draft.description}
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
              placeholder="Add instructions..."
              bordered={false}
              contentClassName="min-h-[160px] text-sm text-muted-foreground"
              onSubmit={() => {
                if (!createRoutine.isPending && draft.title.trim() && draft.projectId && draft.assigneeAgentId) {
                  createRoutine.mutate();
                }
              }}
            />
          </div>

          <div className="border-t border-border/60 px-5 py-3">
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                <div>
                  <p className="text-sm font-medium">Advanced delivery settings</p>
                  <p className="text-sm text-muted-foreground">Keep policy controls secondary to the work definition.</p>
                </div>
                {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Priority</p>
                    <Select value={draft.priority} onValueChange={(priority) => setDraft((current) => ({ ...current, priority }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {priorities.map((priority) => (
                          <SelectItem key={priority} value={priority}>{priority.replace("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Concurrency</p>
                    <Select
                      value={draft.concurrencyPolicy}
                      onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {concurrencyPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Catch-up</p>
                    <Select
                      value={draft.catchUpPolicy}
                      onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catchUpPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <div className="flex flex-col gap-3 border-t border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              After creation, Paperclip takes you straight to trigger setup for schedules, webhooks, or internal runs.
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onClick={() => createRoutine.mutate()}
                disabled={
                  createRoutine.isPending ||
                  !draft.title.trim() ||
                  !draft.projectId ||
                  !draft.assigneeAgentId
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                {createRoutine.isPending ? "Creating..." : "Create routine"}
              </Button>
              {createRoutine.isError ? (
                <p className="text-sm text-destructive">
                  {createRoutine.error instanceof Error ? createRoutine.error.message : "Failed to create routine"}
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load routines"}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4">
        {(routines ?? []).length === 0 ? (
          <EmptyState
            icon={Repeat}
            message="No routines yet. Use Create routine to define the first recurring workflow."
          />
        ) : (
          (routines ?? []).map((routine) => (
            <Card key={routine.id}>
              <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/routines/${routine.id}`} className="text-base font-medium hover:underline">
                      {routine.title}
                    </Link>
                    <Badge variant={routine.status === "active" ? "default" : "secondary"}>
                      {routine.status.replaceAll("_", " ")}
                    </Badge>
                    <Badge variant="outline">{routine.priority}</Badge>
                  </div>
                  {routine.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {routine.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>Project: {projectName.get(routine.projectId) ?? routine.projectId.slice(0, 8)}</span>
                    <span>Assignee: {agentName.get(routine.assigneeAgentId) ?? routine.assigneeAgentId.slice(0, 8)}</span>
                    <span>Concurrency: {routine.concurrencyPolicy.replaceAll("_", " ")}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {routine.triggers.length === 0 ? (
                      <Badge variant="outline">No triggers</Badge>
                    ) : (
                      routine.triggers.map((trigger) => (
                        <Badge key={trigger.id} variant="outline" className="gap-1">
                          {triggerIcon(trigger.kind)}
                          {trigger.label ?? trigger.kind}
                          {!trigger.enabled && " paused"}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-3 md:min-w-[250px]">
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                    <p className="font-medium">Last run</p>
                    {routine.lastRun ? (
                      <div className="mt-1 space-y-1 text-muted-foreground">
                        <p>{routine.lastRun.status.replaceAll("_", " ")}</p>
                        <p>{timeAgo(routine.lastRun.triggeredAt)}</p>
                      </div>
                    ) : (
                      <p className="mt-1 text-muted-foreground">No executions yet.</p>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                    <p className="font-medium">Active execution issue</p>
                    {routine.activeIssue ? (
                      <Link to={`/issues/${routine.activeIssue.identifier ?? routine.activeIssue.id}`} className="mt-1 block text-muted-foreground hover:underline">
                        {routine.activeIssue.identifier ?? routine.activeIssue.id.slice(0, 8)} · {routine.activeIssue.title}
                      </Link>
                    ) : (
                      <p className="mt-1 text-muted-foreground">Nothing open.</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => runRoutine.mutate(routine.id)}
                      disabled={runningRoutineId === routine.id}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      {runningRoutineId === routine.id ? "Running..." : "Run now"}
                    </Button>
                    <Button asChild className="flex-1">
                      <Link to={`/routines/${routine.id}`}>Open</Link>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
