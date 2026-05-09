import { useQuery } from "@tanstack/react-query";
import { listAgentSkills, type AgentSkillRow } from "@/api/learning";

interface AgentSkillsProps {
  agentId: string;
}

export function AgentSkills({ agentId }: AgentSkillsProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent-skills", agentId],
    queryFn: () => listAgentSkills(agentId),
  });
  if (isLoading) return <div className="p-4 text-sm">Loading…</div>;
  if (error)
    return <div className="p-4 text-sm text-destructive">Failed to load skills.</div>;
  const skills = data?.skills ?? [];
  if (skills.length === 0)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No skills derived yet. The skill miner needs at least a few completed runs.
      </div>
    );
  return (
    <div className="space-y-2">
      {skills.map((s) => (
        <SkillRow key={s.skillName} skill={s} />
      ))}
    </div>
  );
}

function SkillRow({ skill }: { skill: AgentSkillRow }) {
  const pct = Math.round(skill.confidence * 100);
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-2 text-sm">
        <code className="font-mono text-xs">{skill.skillName}</code>
        <span className="ml-auto text-xs text-muted-foreground">
          last seen {new Date(skill.lastEvidencedAt).toLocaleDateString()}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-primary"
          style={{ width: `${pct}%` }}
          title={`${pct}% confidence`}
        />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {skill.evidenceRunIds.length} evidence runs · {pct}% confidence
      </div>
    </div>
  );
}
