import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock3,
  Copy,
  Play,
  RefreshCw,
  Repeat,
  Save,
  Webhook,
  Zap,
} from "lucide-react";
import { routinesApi, type RoutineTriggerResponse, type RotateRoutineTriggerResponse } from "../api/routines";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { IssueRow } from "../components/IssueRow";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "../lib/timeAgo";
import type { RoutineTrigger } from "@paperclipai/shared";

const priorities = ["critical", "high", "medium", "low"];
const routineStatuses = ["active", "paused", "archived"];
const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const triggerKinds = ["schedule", "webhook", "api"];
const signingModes = ["bearer", "hmac_sha256"];
const routineTabs = ["triggers", "runs", "issues", "activity"] as const;
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the routine is already active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the routine or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows with a capped backlog after recovery.",
};
const signingModeDescriptions: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
};

type RoutineTab = (typeof routineTabs)[number];

type SecretMessage = {
  title: string;
  webhookUrl: string;
  webhookSecret: string;
};

function isRoutineTab(value: string | null): value is RoutineTab {
  return value !== null && routineTabs.includes(value as RoutineTab);
}

function getRoutineTabFromSearch(search: string): RoutineTab {
  const tab = new URLSearchParams(search).get("tab");
  return isRoutineTab(tab) ? tab : "triggers";
}

function formatActivityDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatActivityDetailValue(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function TriggerEditor({
  trigger,
  onSave,
  onRotate,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    enabled: trigger.enabled ? "true" : "false",
    cronExpression: trigger.cronExpression ?? "",
    timezone: trigger.timezone ?? "UTC",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      enabled: trigger.enabled ? "true" : "false",
      cronExpression: trigger.cronExpression ?? "",
      timezone: trigger.timezone ?? "UTC",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {trigger.kind === "schedule" ? <Clock3 className="h-4 w-4" /> : trigger.kind === "webhook" ? <Webhook className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
          {trigger.label ?? trigger.kind}
        </CardTitle>
        <CardDescription>
          {trigger.kind === "schedule" && trigger.nextRunAt
            ? `Next run ${new Date(trigger.nextRunAt).toLocaleString()}`
            : trigger.kind === "webhook"
              ? "Public webhook trigger"
              : "Authenticated API/manual trigger"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Label</Label>
          <Input
            value={draft.label}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label>Enabled</Label>
          <Select value={draft.enabled} onValueChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">Enabled</SelectItem>
              <SelectItem value="false">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {trigger.kind === "schedule" && (
          <>
            <div className="space-y-2">
              <Label>Cron</Label>
              <Input
                value={draft.cronExpression}
                onChange={(event) => setDraft((current) => ({ ...current, cronExpression: event.target.value }))}
                placeholder="0 10 * * *"
              />
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <Input
                value={draft.timezone}
                onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))}
                placeholder="America/Chicago"
              />
            </div>
          </>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-2">
              <Label>Signing mode</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signingModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Replay window seconds</Label>
              <Input
                value={draft.replayWindowSec}
                onChange={(event) => setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))}
              />
            </div>
          </>
        )}
        <div className="md:col-span-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              onSave(trigger.id, {
                label: draft.label.trim() || null,
                enabled: draft.enabled === "true",
                ...(trigger.kind === "schedule"
                  ? { cronExpression: draft.cronExpression.trim(), timezone: draft.timezone.trim() }
                  : {}),
                ...(trigger.kind === "webhook"
                  ? {
                    signingMode: draft.signingMode,
                    replayWindowSec: Number(draft.replayWindowSec || "300"),
                  }
                  : {}),
              })
            }
          >
            <Save className="mr-2 h-4 w-4" />
            Save trigger
          </Button>
          {trigger.kind === "webhook" && (
            <Button variant="outline" onClick={() => onRotate(trigger.id)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Rotate secret
            </Button>
          )}
          {trigger.lastResult && <span className="text-sm text-muted-foreground">Last result: {trigger.lastResult}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function RoutineDetail() {
  const { routineId } = useParams<{ routineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [newTrigger, setNewTrigger] = useState({
    kind: "schedule",
    label: "",
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    signingMode: "bearer",
    replayWindowSec: "300",
  });
  const [editDraft, setEditDraft] = useState({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
  });
  const activeTab = useMemo(() => getRoutineTabFromSearch(location.search), [location.search]);

  const { data: routine, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.detail(routineId!),
    queryFn: () => routinesApi.get(routineId!),
    enabled: !!routineId,
  });
  const { data: routineRuns } = useQuery({
    queryKey: queryKeys.routines.runs(routineId!),
    queryFn: () => routinesApi.listRuns(routineId!),
    enabled: !!routineId,
  });
  const relatedActivityIds = useMemo(
    () => ({
      triggerIds: routine?.triggers.map((trigger) => trigger.id) ?? [],
      runIds: routineRuns?.map((run) => run.id) ?? [],
    }),
    [routine?.triggers, routineRuns],
  );
  const { data: executionIssues } = useQuery({
    queryKey: ["routine-execution-issues", selectedCompanyId, routineId],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        originKind: "routine_execution",
        originId: routineId!,
        includeRoutineExecutions: true,
      }),
    enabled: !!selectedCompanyId && !!routineId,
  });
  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.routines.activity(selectedCompanyId!, routineId!),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => routinesApi.activity(selectedCompanyId!, routineId!, relatedActivityIds),
    enabled: !!selectedCompanyId && !!routineId && !!routine,
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

  const routineDefaults = useMemo(
    () =>
      routine
        ? {
            title: routine.title,
            description: routine.description ?? "",
            projectId: routine.projectId,
            assigneeAgentId: routine.assigneeAgentId,
            priority: routine.priority,
            status: routine.status,
            concurrencyPolicy: routine.concurrencyPolicy,
            catchUpPolicy: routine.catchUpPolicy,
          }
        : null,
    [routine],
  );
  const isEditDirty = useMemo(() => {
    if (!routineDefaults) return false;
    return (
      editDraft.title !== routineDefaults.title ||
      editDraft.description !== routineDefaults.description ||
      editDraft.projectId !== routineDefaults.projectId ||
      editDraft.assigneeAgentId !== routineDefaults.assigneeAgentId ||
      editDraft.priority !== routineDefaults.priority ||
      editDraft.status !== routineDefaults.status ||
      editDraft.concurrencyPolicy !== routineDefaults.concurrencyPolicy ||
      editDraft.catchUpPolicy !== routineDefaults.catchUpPolicy
    );
  }, [editDraft, routineDefaults]);

  useEffect(() => {
    if (!routine) return;
    setBreadcrumbs([{ label: "Routines", href: "/routines" }, { label: routine.title }]);
    if (!routineDefaults) return;

    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
    }
  }, [routine, routineDefaults, isEditDirty, setBreadcrumbs]);

  const copySecretValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ title: `${label} copied`, tone: "success" });
    } catch (error) {
      pushToast({
        title: `Failed to copy ${label.toLowerCase()}`,
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  const setActiveTab = (value: string) => {
    if (!routineId || !isRoutineTab(value)) return;
    const params = new URLSearchParams(location.search);
    if (value === "triggers") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  };

  const saveRoutine = useMutation({
    mutationFn: () =>
      routinesApi.update(routineId!, {
        ...editDraft,
        description: editDraft.description.trim() || null,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save routine",
        body: error instanceof Error ? error.message : "Paperclip could not save the routine.",
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: () => routinesApi.run(routineId!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Routine run failed",
        body: error instanceof Error ? error.message : "Paperclip could not start the routine run.",
        tone: "error",
      });
    },
  });

  const createTrigger = useMutation({
    mutationFn: async (): Promise<RoutineTriggerResponse> =>
      routinesApi.createTrigger(routineId!, {
        kind: newTrigger.kind,
        label: newTrigger.label.trim() || null,
        ...(newTrigger.kind === "schedule"
          ? { cronExpression: newTrigger.cronExpression.trim(), timezone: newTrigger.timezone.trim() }
          : {}),
        ...(newTrigger.kind === "webhook"
          ? {
            signingMode: newTrigger.signingMode,
            replayWindowSec: Number(newTrigger.replayWindowSec || "300"),
          }
          : {}),
      }),
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: "Webhook trigger created",
          webhookUrl: result.secretMaterial.webhookUrl,
          webhookSecret: result.secretMaterial.webhookSecret,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to add trigger",
        body: error instanceof Error ? error.message : "Paperclip could not create the trigger.",
        tone: "error",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update trigger",
        body: error instanceof Error ? error.message : "Paperclip could not update the trigger.",
        tone: "error",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> => routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        webhookUrl: result.secretMaterial.webhookUrl,
        webhookSecret: result.secretMaterial.webhookSecret,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(routineId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(selectedCompanyId!, routineId!) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rotate webhook secret",
        body: error instanceof Error ? error.message : "Paperclip could not rotate the webhook secret.",
        tone: "error",
      });
    },
  });

  const agentName = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const projectName = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error || !routine) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "Routine not found"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {secretMessage && (
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardHeader>
            <CardTitle className="text-base">{secretMessage.title}</CardTitle>
            <CardDescription>
              Save this now. Paperclip will not show the secret value again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              <Label>Webhook URL</Label>
              <div className="flex items-center gap-2">
                <Input value={secretMessage.webhookUrl} readOnly />
                <Button variant="outline" onClick={() => copySecretValue("Webhook URL", secretMessage.webhookUrl)}>
                  <Copy className="h-4 w-4" />
                  Copy URL
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Secret</Label>
              <div className="flex items-center gap-2">
                <Input value={secretMessage.webhookSecret} readOnly />
                <Button variant="outline" onClick={() => copySecretValue("Webhook secret", secretMessage.webhookSecret)}>
                  <Copy className="h-4 w-4" />
                  Copy secret
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{routine.title}</CardTitle>
              <CardDescription>
                Project {projectName.get(routine.projectId) ?? routine.projectId.slice(0, 8)} · Assignee {agentName.get(routine.assigneeAgentId) ?? routine.assigneeAgentId.slice(0, 8)}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge variant={routine.status === "active" ? "default" : "secondary"}>
                {routine.status.replaceAll("_", " ")}
              </Badge>
              <Button onClick={() => runRoutine.mutate()} disabled={runRoutine.isPending}>
                <Play className="mr-2 h-4 w-4" />
                Run now
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label>Title</Label>
            <Input value={editDraft.title} onChange={(event) => setEditDraft((current) => ({ ...current, title: event.target.value }))} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Instructions</Label>
            <Textarea
              rows={4}
              value={editDraft.description}
              onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Project</Label>
            <Select value={editDraft.projectId} onValueChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}>
              <SelectTrigger>
                <SelectValue />
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
            <Select value={editDraft.assigneeAgentId} onValueChange={(assigneeAgentId) => setEditDraft((current) => ({ ...current, assigneeAgentId }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={editDraft.status} onValueChange={(status) => setEditDraft((current) => ({ ...current, status }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {routineStatuses.map((status) => (
                  <SelectItem key={status} value={status}>{status.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Priority</Label>
            <Select value={editDraft.priority} onValueChange={(priority) => setEditDraft((current) => ({ ...current, priority }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {priorities.map((priority) => (
                  <SelectItem key={priority} value={priority}>{priority}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Concurrency</Label>
            <Select value={editDraft.concurrencyPolicy} onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}>
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
              {concurrencyPolicyDescriptions[editDraft.concurrencyPolicy]}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Catch-up</Label>
            <Select value={editDraft.catchUpPolicy} onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}>
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
              {catchUpPolicyDescriptions[editDraft.catchUpPolicy]}
            </p>
          </div>
          <div className="md:col-span-2 flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {routine.activeIssue ? (
                <span>
                  Active issue:{" "}
                  <Link to={`/issues/${routine.activeIssue.identifier ?? routine.activeIssue.id}`} className="hover:underline">
                    {routine.activeIssue.identifier ?? routine.activeIssue.id.slice(0, 8)}
                  </Link>
                </span>
              ) : (
                "No active execution issue."
              )}
            </div>
            <div className="flex items-center gap-3">
              {isEditDirty && (
                <span className="text-xs text-amber-600">
                  Unsaved routine edits stay local until you save.
                </span>
              )}
              <Button onClick={() => saveRoutine.mutate()} disabled={saveRoutine.isPending}>
                <Save className="mr-2 h-4 w-4" />
                Save routine
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="triggers">Triggers</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="issues">Execution Issues</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="triggers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Add Trigger</CardTitle>
              <CardDescription>
                Schedules, public webhooks, or authenticated internal runs all flow into the same routine run log.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Trigger kind</Label>
                <Select value={newTrigger.kind} onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {triggerKinds.map((kind) => (
                      <SelectItem key={kind} value={kind}>{kind}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Label</Label>
                <Input value={newTrigger.label} onChange={(event) => setNewTrigger((current) => ({ ...current, label: event.target.value }))} />
              </div>
              {newTrigger.kind === "schedule" && (
                <>
                  <div className="space-y-2">
                    <Label>Cron</Label>
                    <Input value={newTrigger.cronExpression} onChange={(event) => setNewTrigger((current) => ({ ...current, cronExpression: event.target.value }))} />
                    <p className="text-xs text-muted-foreground">
                      Five fields, minute first. Example: <code>0 10 * * 1-5</code> runs at 10:00 on weekdays.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Input value={newTrigger.timezone} onChange={(event) => setNewTrigger((current) => ({ ...current, timezone: event.target.value }))} />
                    <p className="text-xs text-muted-foreground">
                      Use an IANA timezone such as <code>America/Chicago</code> so schedules follow local time.
                    </p>
                  </div>
                </>
              )}
              {newTrigger.kind === "webhook" && (
                <>
                  <div className="space-y-2">
                    <Label>Signing mode</Label>
                    <Select value={newTrigger.signingMode} onValueChange={(signingMode) => setNewTrigger((current) => ({ ...current, signingMode }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {signingModes.map((mode) => (
                          <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {signingModeDescriptions[newTrigger.signingMode]}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Replay window seconds</Label>
                    <Input value={newTrigger.replayWindowSec} onChange={(event) => setNewTrigger((current) => ({ ...current, replayWindowSec: event.target.value }))} />
                    <p className="text-xs text-muted-foreground">
                      Reject webhook requests that arrive too late. A common starting point is 300 seconds.
                    </p>
                  </div>
                </>
              )}
              <div className="md:col-span-2 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Webhook triggers return a one-time URL and secret. Copy them immediately.
                </p>
                <Button onClick={() => createTrigger.mutate()} disabled={createTrigger.isPending}>
                  {createTrigger.isPending ? "Adding..." : "Add trigger"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4">
            {routine.triggers.length === 0 ? (
              <EmptyState icon={Repeat} message="No triggers configured yet. Add the first trigger above to make this routine run." />
            ) : (
              routine.triggers.map((trigger) => (
                <TriggerEditor
                  key={trigger.id}
                  trigger={trigger}
                  onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
                  onRotate={(id) => rotateTrigger.mutate(id)}
                />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="runs">
          <Card>
            <CardHeader>
              <CardTitle>Run History</CardTitle>
              <CardDescription>Every trigger occurrence is captured here, whether it created work or was coalesced.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(routineRuns ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                (routineRuns ?? []).map((run) => (
                  <div key={run.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{run.source}</Badge>
                      <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                        {run.status.replaceAll("_", " ")}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                    </div>
                    {run.trigger && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Trigger: {run.trigger.label ?? run.trigger.kind}
                      </p>
                    )}
                    {run.linkedIssue && (
                      <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className="mt-2 block text-sm hover:underline">
                        {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)} · {run.linkedIssue.title}
                      </Link>
                    )}
                    {run.failureReason && (
                      <p className="mt-2 text-sm text-destructive">{run.failureReason}</p>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="issues">
          <Card>
            <CardHeader>
              <CardTitle>Execution Issues</CardTitle>
              <CardDescription>These are the actual issue records created from the routine.</CardDescription>
            </CardHeader>
            <CardContent>
              {(executionIssues ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No execution issues yet.</p>
              ) : (
                <div>
                  {(executionIssues ?? []).map((issue) => (
                    <IssueRow key={issue.id} issue={issue} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Routine-level mutations and operator actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(activity ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                (activity ?? []).map((event) => (
                  <div key={event.id} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{event.action.replaceAll(".", " ")}</span>
                      <span className="text-muted-foreground">{timeAgo(event.createdAt)}</span>
                    </div>
                    {event.details && Object.keys(event.details).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {Object.entries(event.details).map(([key, value]) => (
                          <span key={key} className="rounded-full border border-border bg-muted/40 px-2 py-1">
                            <span className="font-medium text-foreground/80">{key.replaceAll("_", " ")}:</span>{" "}
                            {formatActivityDetailValue(value)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
