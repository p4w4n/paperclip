// Plugin contract for the Memory + Knowledge subsystem (Plan 1 of 2).
// Two backends in one module: MemoryBackend handles fact-per-row
// storage (Mem0-shaped); WikiBackend handles markdown wiki pages
// (Karpathy-shaped, gist 442a6bf, April 2026). They're separately
// pluggable so production tenants can swap one without the other —
// e.g., Mem0 for facts + filesystem markdown for pages.
//
// Tenant isolation is the service-layer concern (not the backends'),
// but every input carries `companyId` so the backend can scope SQL
// directly without re-deriving from session state.

export type MemoryKind = "episodic" | "semantic" | "procedural";

export interface MemoryScope {
  companyId: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKind?: "issue" | "run";
}

// ---------------------------------------------------------------------
// Facts (MemoryBackend)
// ---------------------------------------------------------------------

export interface WriteInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  payload?: Record<string, unknown>;
  sourceRunId?: string;
}

export interface RecallInput {
  scope: MemoryScope;
  query: string;
  limit?: number; // default 10
  kinds?: MemoryKind[];
}

export interface RecalledEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  payload?: Record<string, unknown>;
  scope: { kind: "user" | "company" | "agent" | "session" };
  score: number; // 0..1
  sourceRunId?: string;
}

export interface ForgetInput {
  id: string;
  reason: "user" | "expired" | "consolidated";
}

export interface MemoryBackend {
  write(input: WriteInput): Promise<{ id: string }>;
  recall(input: RecallInput): Promise<RecalledEntry[]>;
  forget(input: ForgetInput): Promise<void>;
}

// ---------------------------------------------------------------------
// Wiki pages (WikiBackend)
// ---------------------------------------------------------------------

export interface PageUpsertInput {
  scope: MemoryScope;
  slug: string;
  title: string;
  contentMarkdown: string;
  sourceEntryIds?: string[];
  // Internal links by slug; the service resolves to page ids and
  // writes memory_page_links. Missing target slugs are silently
  // dropped (no dangling links).
  links?: Array<{ slug: string; linkText?: string }>;
}

export interface PageRecallInput {
  scope: MemoryScope;
  query: string;
  limit?: number; // default 5
  expandLinks?: boolean; // default true — pull in 1-hop linked pages
}

export interface RecalledPage {
  id: string;
  slug: string;
  title: string;
  contentMarkdown: string;
  scope: { kind: "user" | "company" | "agent" | "session" };
  score: number; // 0..1
  matchedVia: "embedding" | "link";
  // The pages directly linked from this one, when expandLinks is true.
  linkedPages?: Array<{ id: string; slug: string; title: string }>;
}

// LlmClient is the minimal LLM-call surface the lint operation needs;
// production wires it to the existing claude_local / gemini_local
// adapter, billed to a system agent.
export interface LlmClient {
  generate(input: { system: string; user: string }): Promise<string>;
}

export interface WikiBackend {
  upsertPage(input: PageUpsertInput): Promise<{ id: string; superseded: boolean }>;
  recallPages(input: PageRecallInput): Promise<RecalledPage[]>;
  lintPage(input: { pageId: string; llm: LlmClient }): Promise<{
    newRevisionId: string | null;
    status: "clean" | "stale" | "contradicted" | "needs_split";
    notes: string;
  }>;
  listLinkedPages(input: { pageId: string; depth?: number }): Promise<RecalledPage[]>;
  forget(input: ForgetInput): Promise<void>;
}

// Shared error class — thrown by the service layer when a caller's
// company doesn't match the input's companyId. Surfaced through the
// API as a 403.
export class MemoryTenantMismatchError extends Error {
  constructor(callerCompanyId: string, inputCompanyId: string) {
    super(
      `memory tenant mismatch: caller company ${callerCompanyId} does not match input ${inputCompanyId}`,
    );
    this.name = "MemoryTenantMismatchError";
  }
}
