import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { Repeat, Plus, Play, Clock3, Webhook } from "lucide-react";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
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

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
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
    onError: (error) => {
      pushToast({
        title: "Routine run failed",
        body: error instanceof Error ? error.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  const agentName = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const projectName = new Map((projects ?? []).map((project) => [project.id, project.name]));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Create Routine</CardTitle>
          <CardDescription>
            Define recurring work once, then add the first trigger on the next screen to make it live.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="routine-title">Title</Label>
            <Input
              id="routine-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="Review the last 24 hours of merged code"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="routine-description">Instructions</Label>
            <Textarea
              id="routine-description"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              rows={4}
              placeholder="Summarize noteworthy changes, update docs if needed, and leave a concise report."
            />
          </div>
          <div className="space-y-2">
            <Label>Project</Label>
            <Select value={draft.projectId} onValueChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}>
              <SelectTrigger>
                <SelectValue placeholder="Choose project" />
              </SelectTrigger>
              <SelectContent>
                {(projects ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Assignee</Label>
            <Select
              value={draft.assigneeAgentId}
              onValueChange={(assigneeAgentId) => setDraft((current) => ({ ...current, assigneeAgentId }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose assignee" />
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Priority</Label>
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
            <Label>Concurrency</Label>
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
            <p className="text-xs text-muted-foreground">
              {concurrencyPolicyDescriptions[draft.concurrencyPolicy]}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Catch-up</Label>
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
            <p className="text-xs text-muted-foreground">
              {catchUpPolicyDescriptions[draft.catchUpPolicy]}
            </p>
          </div>
          <div className="md:col-span-2 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              After creation, Paperclip takes you straight to trigger setup for schedule, webhook, or API entrypoints.
            </p>
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
              {createRoutine.isPending ? "Creating..." : "Create Routine"}
            </Button>
          </div>
          {createRoutine.isError && (
            <p className="md:col-span-2 text-sm text-destructive">
              {createRoutine.error instanceof Error ? createRoutine.error.message : "Failed to create routine"}
            </p>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load routines"}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {(routines ?? []).length === 0 ? (
          <EmptyState
            icon={Repeat}
            message="No routines yet. Create the first recurring workflow above."
          />
        ) : (
          (routines ?? []).map((routine) => (
            <Card key={routine.id}>
              <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-start md:justify-between">
                <div className="space-y-3 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/routines/${routine.id}`} className="text-base font-medium hover:underline">
                      {routine.title}
                    </Link>
                    <Badge variant={routine.status === "active" ? "default" : "secondary"}>
                      {routine.status.replaceAll("_", " ")}
                    </Badge>
                    <Badge variant="outline">{routine.priority}</Badge>
                  </div>
                  {routine.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {routine.description}
                    </p>
                  )}
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
