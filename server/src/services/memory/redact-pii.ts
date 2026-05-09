// PII redaction layer. Runs pre-write so memory_entries never stores
// raw PII. Two stages:
//
//   1. Regex pre-scrub for obvious patterns (email, phone, SSN-like,
//      credit-card, IPv4, AWS access keys, GitHub PATs). Fast, no
//      LLM cost.
//   2. Optional LLM stub for ambiguous cases (people's names,
//      address fragments). The interface is here; the actual LLM
//      call wires up in Plan 2 — for now it's a no-op pass-through
//      so callers can swap when the redaction model lands.
//
// Replacement format: `[REDACTED:<kind>]` so the redacted form is
// readable and the agent can still reason about structure.
//
// Important: regex PII is necessarily best-effort. Do NOT treat the
// redactor as a compliance gate — it's defense-in-depth.

export interface RedactionResult {
  redacted: string;
  redactedKinds: string[];
  changed: boolean;
}

interface Pattern {
  kind: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // GitHub PAT formats (classic + fine-grained). Highest specificity
  // first so they don't get caught by other rules.
  { kind: "github_pat", regex: /\bgh[psour]_[A-Za-z0-9]{36,}\b/g },
  // AWS Access Key ID
  { kind: "aws_access_key", regex: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Credit card (loose Luhn-shaped 13-19 digits with optional dashes/spaces)
  {
    kind: "credit_card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
  },
  // Phone number (various international formats)
  {
    kind: "phone",
    regex:
      /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
  // SSN (US) - 3-2-4 digit groups
  { kind: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // IPv4 — last so it doesn't pre-empt phone matches.
  { kind: "ipv4", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export function redactPii(input: string): RedactionResult {
  let out = input;
  const kinds = new Set<string>();
  for (const p of PATTERNS) {
    out = out.replace(p.regex, () => {
      kinds.add(p.kind);
      return `[REDACTED:${p.kind}]`;
    });
  }
  return {
    redacted: out,
    redactedKinds: [...kinds],
    changed: out !== input,
  };
}

// LLM stub. Plan 2 will wire this to a small classifier model that
// catches names + address fragments + other ambiguous PII the regex
// layer misses. For now: pass-through.
export interface PiiClassifier {
  classify(text: string): Promise<{ redacted: string; kinds: string[] }>;
}

export const noopPiiClassifier: PiiClassifier = {
  async classify(text) {
    return { redacted: text, kinds: [] };
  },
};

export async function redactPiiTwoStage(
  input: string,
  classifier: PiiClassifier = noopPiiClassifier,
): Promise<RedactionResult> {
  const stage1 = redactPii(input);
  const stage2 = await classifier.classify(stage1.redacted);
  const allKinds = new Set([...stage1.redactedKinds, ...stage2.kinds]);
  return {
    redacted: stage2.redacted,
    redactedKinds: [...allKinds],
    changed: stage2.redacted !== input,
  };
}
