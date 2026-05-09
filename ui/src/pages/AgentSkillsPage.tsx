import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { AgentSkills } from "@/features/agents/AgentSkills";

export function AgentSkillsPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { agentId } = useParams<{ agentId: string }>();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: agentId ?? "?", href: agentId ? `/agents/${agentId}` : undefined },
      { label: "Skills" },
    ]);
  }, [setBreadcrumbs, agentId]);

  if (!agentId) return <div className="p-4">Agent not specified.</div>;
  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-semibold">Agent skills</h1>
      <p className="text-sm text-muted-foreground">
        Skills derived by the learning subsystem from this agent's run history. Confidence
        decays over time when the skill stops being evidenced.
      </p>
      <AgentSkills agentId={agentId} />
    </div>
  );
}
