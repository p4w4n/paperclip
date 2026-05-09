// Skill miner.
//
// Pure helper extractSkillsFromRun(runSummary, llm) →
// Promise<string[]>. Free-form skill names; the LLM tags from the
// run's summary text. Tests mock the LLM.
//
// computeSkillDecay({ confidence, lastEvidencedAt, now }): pure
// helper applied in the tick — drops confidence by 0.1 per month
// past the last-evidence date. Skills below the floor (0.05) get
// deleted in the tick.

const SYSTEM_PROMPT = `Extract a list of technologies, domains, or task types this run touched.

Output STRICT JSON: an array of short kebab-case strings, max 8 entries.
Examples: ["typescript-refactor", "postgres-migration", "incident-response"].
If you can't determine any, return [].
Be specific — prefer "react-component-refactor" over "frontend".`;

export interface SkillsLlmClient {
  generate(input: { system: string; user: string }): Promise<string>;
}

export async function extractSkillsFromRun(
  runSummary: string,
  llm: SkillsLlmClient,
): Promise<string[]> {
  if (!runSummary || runSummary.trim().length === 0) return [];
  let raw: string;
  try {
    raw = await llm.generate({ system: SYSTEM_PROMPT, user: runSummary });
  } catch {
    return [];
  }
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: unknown): s is string => typeof s === "string")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export interface SkillDecayInput {
  confidence: number;
  lastEvidencedAt: Date;
  now?: Date;
  // Decay rate per month. Default 0.1.
  ratePerMonth?: number;
}

export const SKILL_FLOOR = 0.05;

export function computeSkillDecay(input: SkillDecayInput): number {
  const now = input.now ?? new Date();
  const ms = Math.max(0, now.getTime() - input.lastEvidencedAt.getTime());
  const months = ms / (30 * 24 * 60 * 60 * 1000);
  const rate = input.ratePerMonth ?? 0.1;
  const decayed = input.confidence - months * rate;
  return Math.max(0, decayed);
}

export function shouldDeleteSkill(confidence: number): boolean {
  return confidence < SKILL_FLOOR;
}
