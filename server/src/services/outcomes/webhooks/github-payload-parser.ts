// Pure parser for GitHub pull_request webhook payloads.
// No DB access; isolates identifier extraction from the route handler.

export type ParseResult =
  | { kind: "merged"; prNumber: number; prUrl: string; title: string; body: string; branch: string }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid_payload"; reason: string };

export function parseGithubPrEvent(payload: unknown): ParseResult {
  if (typeof payload !== "object" || payload === null) {
    return { kind: "invalid_payload", reason: "payload not an object" };
  }
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? p.action : "";
  const pr = (p.pull_request ?? null) as Record<string, unknown> | null;
  if (!pr) return { kind: "invalid_payload", reason: "missing pull_request" };

  if (action !== "closed") return { kind: "ignored", reason: `action=${action}` };
  if (pr.merged !== true) return { kind: "ignored", reason: "closed but not merged" };

  return {
    kind: "merged",
    prNumber: typeof pr.number === "number" ? pr.number : 0,
    prUrl: typeof pr.html_url === "string" ? pr.html_url : "",
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    branch: typeof (pr.head as { ref?: string })?.ref === "string" ? (pr.head as { ref: string }).ref : "",
  };
}

export function extractIssueIdentifier(payload: unknown, prefix: string): string | null {
  const parsed = parseGithubPrEvent(payload);
  if (parsed.kind !== "merged") return null;

  const re = new RegExp(`\\b${prefix}-(\\d+)\\b`, "i");
  for (const haystack of [parsed.title, parsed.body, parsed.branch]) {
    const match = haystack.match(re);
    if (match) return `${prefix}-${match[1]}`;
  }
  return null;
}
