// Build the memory prompt-prefix. The agent's executeRun loop calls
// recall + recallPages, then this helper renders the hits as a
// stable system-prompt block prepended to the agent's user prompt.
//
// Format choices (verified against gist 442a6bf — Karpathy LLM-Wiki):
//   - Pages render first, in markdown, separated by --- horizontal
//     rules. Pages are the curated layer; the agent treats them as
//     authoritative.
//   - Facts render second as a compact bullet list, ordered by
//     score. Facts are noisy episodic + semantic, not authoritative.
//   - The whole block is wrapped in <memory>...</memory> so the
//     agent can recognize provenance and the prompt's downstream
//     consumers can strip if needed.
//
// Token budget: target ~1500 tokens (~6KB at 4 chars/token average).
// We trim greedily by score; the highest-scored items survive.
//
// heartbeat.ts wiring deferred (same as M-6) — this module ships the
// prompt builder + tests; the integration site lands when the
// surrounding heartbeat refactor happens.

import type { RecalledEntry, RecalledPage } from "./types.js";

const MAX_BUDGET_CHARS = 6000; // ~1500 tokens at 4 char/token
const PAGE_DIVIDER = "\n\n---\n\n";

export interface PromptPrefixInput {
  pages: RecalledPage[];
  facts: RecalledEntry[];
  // Optional: top-N suggested playbooks from the Org Learning
  // subsystem. Rendered above pages + facts when present.
  playbooks?: Array<{ title: string; body: string; score: number; reason?: string }>;
  // Override the budget, primarily for tests.
  maxBudgetChars?: number;
}

export interface PromptPrefixResult {
  text: string;
  truncated: boolean;
  pagesIncluded: number;
  factsIncluded: number;
  playbooksIncluded: number;
}

export function buildMemoryPromptPrefix(input: PromptPrefixInput): PromptPrefixResult {
  const playbooks = input.playbooks ?? [];
  if (
    input.pages.length === 0 &&
    input.facts.length === 0 &&
    playbooks.length === 0
  ) {
    return {
      text: "",
      truncated: false,
      pagesIncluded: 0,
      factsIncluded: 0,
      playbooksIncluded: 0,
    };
  }

  const budget = input.maxBudgetChars ?? MAX_BUDGET_CHARS;
  const sortedPages = [...input.pages].sort((a, b) => b.score - a.score);
  const sortedFacts = [...input.facts].sort((a, b) => b.score - a.score);
  const sortedPlaybooks = [...playbooks].sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  let used = "<memory>\n</memory>".length;
  let truncated = false;
  let playbooksIncluded = 0;

  // Suggested playbooks render first — agents should treat them
  // as the primary procedural reference for matching issues.
  if (sortedPlaybooks.length > 0) {
    const renderedPlaybooks: string[] = [];
    for (const pb of sortedPlaybooks) {
      const block = `### ${pb.title}\n${pb.body}`;
      if (used + block.length + PAGE_DIVIDER.length > budget) {
        truncated = true;
        break;
      }
      renderedPlaybooks.push(block);
      used += block.length + PAGE_DIVIDER.length;
      playbooksIncluded++;
    }
    if (renderedPlaybooks.length > 0) {
      parts.push("## Suggested playbooks\n\n" + renderedPlaybooks.join(PAGE_DIVIDER));
      used += "## Suggested playbooks\n\n".length;
    }
  }

  // Pages first.
  const includedPages: string[] = [];
  for (const page of sortedPages) {
    const block = renderPage(page);
    const cost = block.length + (includedPages.length > 0 ? PAGE_DIVIDER.length : 0);
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    includedPages.push(block);
    used += cost;
  }
  if (includedPages.length > 0) {
    parts.push("## Wiki pages\n\n" + includedPages.join(PAGE_DIVIDER));
    used += "## Wiki pages\n\n".length;
  }

  // Facts second, as bullet list.
  const includedFacts: string[] = [];
  for (const fact of sortedFacts) {
    const line = renderFactBullet(fact);
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    includedFacts.push(line);
    used += line.length + 1;
  }
  if (includedFacts.length > 0) {
    const sep = parts.length > 0 ? "\n\n" : "";
    parts.push(`${sep}## Facts\n\n${includedFacts.join("\n")}`);
  }

  if (parts.length === 0) {
    return {
      text: "",
      truncated: true,
      pagesIncluded: 0,
      factsIncluded: 0,
      playbooksIncluded: 0,
    };
  }

  const text = `<memory>\n${parts.join("")}\n</memory>`;
  return {
    text,
    truncated,
    pagesIncluded: includedPages.length,
    factsIncluded: includedFacts.length,
    playbooksIncluded,
  };
}

function renderPage(page: RecalledPage): string {
  const linkLine =
    page.linkedPages && page.linkedPages.length > 0
      ? `\n*Links: ${page.linkedPages.map((l) => `[[${l.slug}]]`).join(", ")}*\n`
      : "";
  return `### ${page.title} (${page.slug})\n${linkLine}${page.contentMarkdown}`;
}

function renderFactBullet(fact: RecalledEntry): string {
  const tag = `[${fact.kind}]`;
  // Trim very long fact content so one outlier can't blow the
  // budget.
  const content = fact.content.length > 280 ? fact.content.slice(0, 280) + "…" : fact.content;
  return `- ${tag} ${content}`;
}
