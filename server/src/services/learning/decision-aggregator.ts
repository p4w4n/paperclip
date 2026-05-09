// Decision-pattern aggregator. Pure helper.
//
// groupDecisionsByCondition takes plan_decisions rows + an LLM
// client; clusters decisions by content-hash signature on
// (title, options, rationale), then asks the LLM to synthesize
// a {condition_summary, typical_choice} for each cluster of size
// ≥ minClusterSize.

export interface DecisionForAggregation {
  id: string;
  title: string;
  rationaleMarkdown: string | null;
  options: Array<{ id: string; label: string }>;
  chosenOptionId: string;
}

export interface DecisionGroup {
  signature: string;
  conditionSummary: string;
  typicalChoice: string;
  exemplarDecisionIds: string[];
  clusterSize: number;
}

export interface AggregatorOpts {
  minClusterSize?: number;
  maxExemplars?: number;
  llm?: { generate(input: { system: string; user: string }): Promise<string> };
  maxLlmCalls?: number;
}

const SYSTEM_PROMPT = `You summarize a cluster of similar decisions across project plans.

Input: a list of (decision_title + rationale + chosen option).
Output STRICT JSON: {"condition": "When [...]", "choice": "[chosen value]"}.

The "condition" should describe the situations where this choice tends to be made;
the "choice" should be the dominant option label across exemplars.`;

export async function groupDecisionsByCondition(
  decisions: ReadonlyArray<DecisionForAggregation>,
  opts: AggregatorOpts = {},
): Promise<DecisionGroup[]> {
  const minClusterSize = opts.minClusterSize ?? 2;
  const maxExemplars = opts.maxExemplars ?? 5;
  const maxLlmCalls = opts.maxLlmCalls ?? 10;

  // Cluster by title-token signature.
  const groups = new Map<string, DecisionForAggregation[]>();
  for (const d of decisions) {
    const sig = signatureFor(d);
    const list = groups.get(sig) ?? [];
    list.push(d);
    groups.set(sig, list);
  }

  let llmCallsRemaining = maxLlmCalls;
  const out: DecisionGroup[] = [];
  for (const [signature, group] of groups) {
    if (group.length < minClusterSize) continue;
    const choices = new Map<string, number>();
    for (const d of group) {
      const label = d.options.find((o) => o.id === d.chosenOptionId)?.label ?? d.chosenOptionId;
      choices.set(label, (choices.get(label) ?? 0) + 1);
    }
    const dominant = [...choices.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "(none)";

    let conditionSummary = group[0].title;
    let typicalChoice = dominant;

    if (opts.llm && llmCallsRemaining > 0) {
      llmCallsRemaining--;
      try {
        const raw = await opts.llm.generate({
          system: SYSTEM_PROMPT,
          user: group
            .map((d) => `- ${d.title}: chose ${
              d.options.find((o) => o.id === d.chosenOptionId)?.label ?? d.chosenOptionId
            }${d.rationaleMarkdown ? `; reason: ${d.rationaleMarkdown}` : ""}`)
            .join("\n"),
        });
        const parsed = parseLlmResponse(raw);
        if (parsed) {
          conditionSummary = parsed.condition;
          typicalChoice = parsed.choice;
        }
      } catch {
        // Fall back to defaults; don't surface the error.
      }
    }

    out.push({
      signature,
      conditionSummary,
      typicalChoice,
      exemplarDecisionIds: group.slice(0, maxExemplars).map((d) => d.id),
      clusterSize: group.length,
    });
  }
  return out;
}

function signatureFor(d: DecisionForAggregation): string {
  const tokens = d.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  return [...new Set(tokens)].sort().join(" ");
}

function parseLlmResponse(raw: string): { condition: string; choice: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (typeof obj?.condition !== "string" || typeof obj?.choice !== "string") return null;
    return { condition: obj.condition, choice: obj.choice };
  } catch {
    return null;
  }
}
