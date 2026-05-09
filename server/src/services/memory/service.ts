// Process-wide memory service. Wraps a MemoryBackend (facts) and a
// WikiBackend (pages) with three responsibilities:
//
//   1. Tenant isolation. Every call carries a callerCompanyId; the
//      service rejects any input whose scope.companyId differs.
//      Cross-tenant memory leakage is the highest-risk failure
//      mode, so this gate runs in the service layer rather than the
//      backends (any backend swap inherits the gate for free).
//
//   2. Plugin swap. setMemoryBackend / setWikiBackend let the boot
//      wire-up choose between the default pgvector implementation
//      and a plugin-provided one (Mem0 for facts, external markdown
//      source for pages — Plan 2).
//
//   3. OTel hooks. Every method opens a span under the existing
//      gen_ai.agent semconv. Span wiring lands once we touch the
//      OTel module in M-18 — for now the wrappers are call-through
//      shims so the call sites stay stable.

import type {
  ForgetInput,
  LlmClient,
  MemoryBackend,
  PageRecallInput,
  PageUpsertInput,
  RecallInput,
  RecalledEntry,
  RecalledPage,
  WikiBackend,
  WriteInput,
} from "./types.js";
import { MemoryTenantMismatchError } from "./types.js";

export interface MemoryServiceContext {
  callerCompanyId: string;
}

export class MemoryService {
  private memoryBackend: MemoryBackend;
  private wikiBackend: WikiBackend;

  constructor(memoryBackend: MemoryBackend, wikiBackend: WikiBackend) {
    this.memoryBackend = memoryBackend;
    this.wikiBackend = wikiBackend;
  }

  setMemoryBackend(backend: MemoryBackend): void {
    this.memoryBackend = backend;
  }

  setWikiBackend(backend: WikiBackend): void {
    this.wikiBackend = backend;
  }

  // ---------------- facts ----------------

  async write(ctx: MemoryServiceContext, input: WriteInput): Promise<{ id: string }> {
    this.assertTenant(ctx, input.scope.companyId);
    return this.memoryBackend.write(input);
  }

  async recall(ctx: MemoryServiceContext, input: RecallInput): Promise<RecalledEntry[]> {
    this.assertTenant(ctx, input.scope.companyId);
    return this.memoryBackend.recall(input);
  }

  async forget(ctx: MemoryServiceContext, input: ForgetInput & { companyId: string }): Promise<void> {
    this.assertTenant(ctx, input.companyId);
    await this.memoryBackend.forget({ id: input.id, reason: input.reason });
  }

  // ---------------- wiki pages ----------------

  async upsertPage(ctx: MemoryServiceContext, input: PageUpsertInput) {
    this.assertTenant(ctx, input.scope.companyId);
    return this.wikiBackend.upsertPage(input);
  }

  async recallPages(ctx: MemoryServiceContext, input: PageRecallInput): Promise<RecalledPage[]> {
    this.assertTenant(ctx, input.scope.companyId);
    return this.wikiBackend.recallPages(input);
  }

  async lintPage(
    ctx: MemoryServiceContext,
    input: { pageId: string; companyId: string; llm: LlmClient },
  ) {
    this.assertTenant(ctx, input.companyId);
    return this.wikiBackend.lintPage({ pageId: input.pageId, llm: input.llm });
  }

  async listLinkedPages(
    ctx: MemoryServiceContext,
    input: { pageId: string; companyId: string; depth?: number },
  ) {
    this.assertTenant(ctx, input.companyId);
    return this.wikiBackend.listLinkedPages({ pageId: input.pageId, depth: input.depth });
  }

  async forgetPage(
    ctx: MemoryServiceContext,
    input: ForgetInput & { companyId: string },
  ): Promise<void> {
    this.assertTenant(ctx, input.companyId);
    await this.wikiBackend.forget({ id: input.id, reason: input.reason });
  }

  private assertTenant(ctx: MemoryServiceContext, inputCompanyId: string): void {
    if (ctx.callerCompanyId !== inputCompanyId) {
      throw new MemoryTenantMismatchError(ctx.callerCompanyId, inputCompanyId);
    }
  }
}

// Process-wide singleton. Boot wiring (server/src/index.ts) calls
// setMemoryBackend / setWikiBackend with the production backends
// before any caller hits these methods.
let singleton: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!singleton) {
    throw new Error(
      "MemoryService not initialized — call initializeMemoryService(memoryBackend, wikiBackend) at boot",
    );
  }
  return singleton;
}

export function initializeMemoryService(
  memoryBackend: MemoryBackend,
  wikiBackend: WikiBackend,
): MemoryService {
  if (singleton) {
    singleton.setMemoryBackend(memoryBackend);
    singleton.setWikiBackend(wikiBackend);
  } else {
    singleton = new MemoryService(memoryBackend, wikiBackend);
  }
  return singleton;
}
