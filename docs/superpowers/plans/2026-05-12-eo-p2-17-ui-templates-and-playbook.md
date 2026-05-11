# EO-P2-17: UI Plan Templates + PlanTemplatePicker + Apply-Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/admin/plan-templates` CRUD page, reusable `PlanTemplatePicker` dropdown, and an `[Apply]` button on IssueDetail's suggested-playbooks panel to POST to `apply-playbook`.

**Architecture:** API client `plan-templates.ts` follows existing `outcomes.ts`/`learning.ts` patterns; `PlanTemplates.tsx` mirrors `AdminLearning.tsx` layout with table + create/edit modals; `PlanTemplatePicker.tsx` is a small standalone dropdown; IssueDetail and PlanDetail are extended minimally.

**Tech Stack:** React 18, TanStack Query, Vitest + jsdom, TypeScript, Tailwind CSS, Lucide icons, shadcn/ui Dialog/Button components.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `ui/src/api/plan-templates.ts` | Fetch wrappers for 6 plan-template endpoints |
| Create | `ui/src/pages/PlanTemplates.tsx` | `/admin/plan-templates` table + create/edit modals |
| Create | `ui/src/components/PlanTemplatePicker.tsx` | Reusable select dropdown for active templates |
| Create | `ui/src/pages/__tests__/PlanTemplates.test.tsx` | Vitest jsdom test for PlanTemplates page |
| Create | `ui/src/components/__tests__/PlanTemplatePicker.test.tsx` | Vitest jsdom test for picker component |
| Modify | `ui/src/App.tsx` | Register `/admin/plan-templates` route |
| Modify | `ui/src/pages/IssueDetail.tsx` | Add `[Apply]` button panel in the Plan tab area |
| Modify | `ui/src/pages/PlanDetail.tsx` | Expose PlanTemplatePicker in header area |

---

## Task 1: API client — `plan-templates.ts`

**Files:**
- Create: `ui/src/api/plan-templates.ts`

- [ ] **Step 1: Create the file**

```typescript
// ui/src/api/plan-templates.ts
import { api } from "./client";

export interface PlanTemplateRow {
  id: string;
  companyId: string;
  name: string;
  descriptionMarkdown: string | null;
  initialContentMarkdown: string | null;
  defaultApprovalPolicy: string | null;
  defaultPhaseAdvancePolicy: string | null;
  suggestedOutcomesJson: unknown[] | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ListPlanTemplatesResponse {
  templates: PlanTemplateRow[];
}

export function listPlanTemplates(
  companyId: string,
  opts: { status?: string } = {},
): Promise<ListPlanTemplatesResponse> {
  const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
  return api.get<ListPlanTemplatesResponse>(
    `/companies/${encodeURIComponent(companyId)}/plan-templates${qs}`,
  );
}

export function getPlanTemplate(id: string): Promise<{ template: PlanTemplateRow }> {
  return api.get<{ template: PlanTemplateRow }>(
    `/plan-templates/${encodeURIComponent(id)}`,
  );
}

export function createPlanTemplate(
  companyId: string,
  body: {
    name: string;
    descriptionMarkdown?: string;
    initialContentMarkdown?: string;
    defaultApprovalPolicy?: string;
    defaultPhaseAdvancePolicy?: string;
    suggestedOutcomesJson?: unknown[];
  },
): Promise<{ template: PlanTemplateRow }> {
  return api.post<{ template: PlanTemplateRow }>(
    `/companies/${encodeURIComponent(companyId)}/plan-templates`,
    body,
  );
}

export function updatePlanTemplate(
  id: string,
  body: {
    name?: string;
    descriptionMarkdown?: string;
    initialContentMarkdown?: string;
    defaultApprovalPolicy?: string;
    defaultPhaseAdvancePolicy?: string;
    suggestedOutcomesJson?: unknown[];
  },
): Promise<{ template: PlanTemplateRow }> {
  return api.patch<{ template: PlanTemplateRow }>(
    `/plan-templates/${encodeURIComponent(id)}`,
    body,
  );
}

export function archivePlanTemplate(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/plan-templates/${encodeURIComponent(id)}/archive`,
    {},
  );
}

export function restorePlanTemplate(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/plan-templates/${encodeURIComponent(id)}/restore`,
    {},
  );
}

export function applyPlaybookToIssue(
  companyId: string,
  issueId: string,
  playbookId: string,
  mergeStrategy: "merge" | "replace",
): Promise<{ addedCount: number; skippedCount: number }> {
  return api.post<{ addedCount: number; skippedCount: number }>(
    `/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/apply-playbook`,
    { playbookId, mergeStrategy },
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/pk/paperclip/ui && pnpm exec tsc --noEmit --skipLibCheck 2>&1 | head -30
```

Expected: No errors for the new file (other pre-existing errors unrelated to this file are OK).

---

## Task 2: Write failing tests

**Files:**
- Create: `ui/src/pages/__tests__/PlanTemplates.test.tsx`
- Create: `ui/src/components/__tests__/PlanTemplatePicker.test.tsx`

- [ ] **Step 1: Create the pages tests directory and PlanTemplates test**

```tsx
// ui/src/pages/__tests__/PlanTemplates.test.tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanTemplates } from "../PlanTemplates";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/api/plan-templates", () => ({
  listPlanTemplates: async () => ({
    templates: [
      {
        id: "tpl-1",
        companyId: "company-aaa",
        name: "Sprint Kickoff Template",
        descriptionMarkdown: "Used for sprints",
        initialContentMarkdown: "## Sprint goals\n",
        defaultApprovalPolicy: null,
        defaultPhaseAdvancePolicy: null,
        suggestedOutcomesJson: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
      {
        id: "tpl-2",
        companyId: "company-aaa",
        name: "Incident Response",
        descriptionMarkdown: null,
        initialContentMarkdown: null,
        defaultApprovalPolicy: null,
        defaultPhaseAdvancePolicy: null,
        suggestedOutcomesJson: null,
        status: "active",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        archivedAt: null,
      },
    ],
  }),
  createPlanTemplate: vi.fn(),
  updatePlanTemplate: vi.fn(),
  archivePlanTemplate: vi.fn(),
  restorePlanTemplate: vi.fn(),
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("PlanTemplates page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;

    // Set up a fake URL so companyId can be derived
    Object.defineProperty(window, "location", {
      value: { href: "http://localhost/company-aaa/admin/plan-templates" },
      writable: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("renders table with template names", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<PlanTemplates />);
    });

    await flushReact();

    const text = container.textContent ?? "";
    expect(text).toContain("Sprint Kickoff Template");
    expect(text).toContain("Incident Response");
  });

  it("renders a create button", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<PlanTemplates />);
    });

    await flushReact();

    const buttons = Array.from(container.querySelectorAll("button"));
    const createButton = buttons.find((b) =>
      b.textContent?.toLowerCase().includes("create") ||
      b.textContent?.toLowerCase().includes("new"),
    );
    expect(createButton).toBeDefined();
  });

  it("shows loading state before data arrives", async () => {
    // Never resolve — keep loading
    const { listPlanTemplates } = await import("@/api/plan-templates");
    vi.mocked(listPlanTemplates as unknown as (...args: unknown[]) => unknown).mockReturnValueOnce(
      new Promise(() => {})
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<PlanTemplates />);
    });

    const text = container.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/loading/i);
  });
});
```

- [ ] **Step 2: Create PlanTemplatePicker test**

```tsx
// ui/src/components/__tests__/PlanTemplatePicker.test.tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanTemplatePicker } from "../PlanTemplatePicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/plan-templates", () => ({
  listPlanTemplates: async () => ({
    templates: [
      {
        id: "tpl-1",
        companyId: "company-aaa",
        name: "Sprint Template",
        descriptionMarkdown: null,
        initialContentMarkdown: null,
        defaultApprovalPolicy: null,
        defaultPhaseAdvancePolicy: null,
        suggestedOutcomesJson: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
      {
        id: "tpl-2",
        companyId: "company-aaa",
        name: "Incident Response",
        descriptionMarkdown: null,
        initialContentMarkdown: null,
        defaultApprovalPolicy: null,
        defaultPhaseAdvancePolicy: null,
        suggestedOutcomesJson: null,
        status: "active",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        archivedAt: null,
      },
    ],
  }),
}));

describe("PlanTemplatePicker", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("renders a select with None option and template options", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <PlanTemplatePicker companyId="company-aaa" value={null} onChange={onChange} />,
      );
    });

    // Wait for async template load
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const select = container.querySelector("select");
    expect(select).toBeDefined();

    const options = Array.from(select!.querySelectorAll("option"));
    // First option is "— None —"
    expect(options[0]?.textContent).toContain("None");
    // Template options
    const optionTexts = options.map((o) => o.textContent ?? "");
    expect(optionTexts.some((t) => t.includes("Sprint Template"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("Incident Response"))).toBe(true);
  });

  it("calls onChange with template id when user selects one", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <PlanTemplatePicker companyId="company-aaa" value={null} onChange={onChange} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "tpl-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("tpl-1");
  });

  it("calls onChange with null when user selects None", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <PlanTemplatePicker companyId="company-aaa" value="tpl-1" onChange={onChange} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 3: Run — verify tests fail (files not yet created)**

```bash
cd /home/pk/paperclip/ui && pnpm exec vitest run src/pages/__tests__/PlanTemplates.test.tsx src/components/__tests__/PlanTemplatePicker.test.tsx 2>&1 | tail -20
```

Expected: FAIL — cannot find module `../PlanTemplates` and `../PlanTemplatePicker`.

---

## Task 3: Implement `PlanTemplatePicker.tsx`

**Files:**
- Create: `ui/src/components/PlanTemplatePicker.tsx`

- [ ] **Step 1: Create the file**

```tsx
// ui/src/components/PlanTemplatePicker.tsx
import { useEffect, useState } from "react";
import { listPlanTemplates, type PlanTemplateRow } from "@/api/plan-templates";

interface PlanTemplatePickerProps {
  companyId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

export function PlanTemplatePicker({
  companyId,
  value,
  onChange,
  disabled = false,
}: PlanTemplatePickerProps) {
  const [templates, setTemplates] = useState<PlanTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    listPlanTemplates(companyId, { status: "active" })
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [companyId]);

  return (
    <select
      className="rounded border bg-transparent px-2 py-1 text-sm disabled:opacity-50"
      value={value ?? ""}
      disabled={disabled || loading}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">— None —</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Run picker tests — should pass now**

```bash
cd /home/pk/paperclip/ui && pnpm exec vitest run src/components/__tests__/PlanTemplatePicker.test.tsx 2>&1 | tail -20
```

Expected: PASS all 3 tests.

---

## Task 4: Implement `PlanTemplates.tsx`

**Files:**
- Create: `ui/src/pages/PlanTemplates.tsx`

- [ ] **Step 1: Create the file**

```tsx
// ui/src/pages/PlanTemplates.tsx
import { useEffect, useState } from "react";
import {
  listPlanTemplates,
  createPlanTemplate,
  updatePlanTemplate,
  archivePlanTemplate,
  restorePlanTemplate,
  type PlanTemplateRow,
} from "@/api/plan-templates";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

interface TemplateFormState {
  name: string;
  descriptionMarkdown: string;
  initialContentMarkdown: string;
  defaultApprovalPolicy: string;
  defaultPhaseAdvancePolicy: string;
}

const EMPTY_FORM: TemplateFormState = {
  name: "",
  descriptionMarkdown: "",
  initialContentMarkdown: "",
  defaultApprovalPolicy: "",
  defaultPhaseAdvancePolicy: "",
};

export function PlanTemplates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(
    () => setBreadcrumbs([{ label: "Plan Templates" }]),
    [setBreadcrumbs],
  );

  const url = new URL(window.location.href);
  const companyId = url.pathname.split("/").filter(Boolean)[0] ?? "";

  const [templates, setTemplates] = useState<PlanTemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Modal state
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<PlanTemplateRow | null>(null);
  const [form, setForm] = useState<TemplateFormState>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = () => {
    if (!companyId) return;
    listPlanTemplates(companyId)
      .then((r) => setTemplates(r.templates))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowCreate(true);
    setEditTarget(null);
  };

  const openEdit = (t: PlanTemplateRow) => {
    setForm({
      name: t.name,
      descriptionMarkdown: t.descriptionMarkdown ?? "",
      initialContentMarkdown: t.initialContentMarkdown ?? "",
      defaultApprovalPolicy: t.defaultApprovalPolicy ?? "",
      defaultPhaseAdvancePolicy: t.defaultPhaseAdvancePolicy ?? "",
    });
    setFormError(null);
    setEditTarget(t);
    setShowCreate(false);
  };

  const closeModal = () => {
    setShowCreate(false);
    setEditTarget(null);
    setFormError(null);
  };

  const onSubmitCreate = async () => {
    if (!form.name.trim()) { setFormError("Name is required"); return; }
    setFormBusy(true);
    setFormError(null);
    try {
      await createPlanTemplate(companyId, {
        name: form.name.trim(),
        descriptionMarkdown: form.descriptionMarkdown || undefined,
        initialContentMarkdown: form.initialContentMarkdown || undefined,
        defaultApprovalPolicy: form.defaultApprovalPolicy || undefined,
        defaultPhaseAdvancePolicy: form.defaultPhaseAdvancePolicy || undefined,
      });
      closeModal();
      reload();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : "Failed to create template");
    } finally {
      setFormBusy(false);
    }
  };

  const onSubmitEdit = async () => {
    if (!editTarget) return;
    if (!form.name.trim()) { setFormError("Name is required"); return; }
    setFormBusy(true);
    setFormError(null);
    try {
      await updatePlanTemplate(editTarget.id, {
        name: form.name.trim(),
        descriptionMarkdown: form.descriptionMarkdown || undefined,
        initialContentMarkdown: form.initialContentMarkdown || undefined,
        defaultApprovalPolicy: form.defaultApprovalPolicy || undefined,
        defaultPhaseAdvancePolicy: form.defaultPhaseAdvancePolicy || undefined,
      });
      closeModal();
      reload();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : "Failed to update template");
    } finally {
      setFormBusy(false);
    }
  };

  const onArchive = async (t: PlanTemplateRow) => {
    setBusy(t.id);
    try {
      await archivePlanTemplate(t.id);
      reload();
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async (t: PlanTemplateRow) => {
    setBusy(t.id);
    try {
      await restorePlanTemplate(t.id);
      reload();
    } finally {
      setBusy(null);
    }
  };

  if (!companyId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open this page from inside a company context.
      </div>
    );
  }

  const isModalOpen = showCreate || !!editTarget;
  const modalTitle = editTarget ? "Edit template" : "Create template";
  const onModalSubmit = editTarget ? onSubmitEdit : onSubmitCreate;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Plan templates</h1>
        <button
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          onClick={openCreate}
        >
          New template
        </button>
      </div>

      {error && (
        <div className="text-sm text-destructive">{error}</div>
      )}

      {!templates ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="text-sm text-muted-foreground">No templates yet. Create one to get started.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-1">Name</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-2 font-medium">{t.name}</td>
                <td>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      t.status === "active"
                        ? "bg-green-100 text-green-700"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t.status}
                  </span>
                </td>
                <td className="text-muted-foreground">
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td className="space-x-2">
                  <button
                    className="text-xs underline disabled:opacity-50"
                    onClick={() => openEdit(t)}
                    disabled={busy === t.id}
                  >
                    Edit
                  </button>
                  {t.status === "active" ? (
                    <button
                      className="text-xs text-destructive underline disabled:opacity-50"
                      onClick={() => onArchive(t)}
                      disabled={busy === t.id}
                    >
                      Archive
                    </button>
                  ) : (
                    <button
                      className="text-xs text-green-600 underline disabled:opacity-50"
                      onClick={() => onRestore(t)}
                      disabled={busy === t.id}
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create / Edit modal (simple inline overlay) */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
            <h2 className="mb-4 text-base font-semibold">{modalTitle}</h2>
            <div className="space-y-3">
              <Field label="Name *">
                <input
                  className="w-full rounded border bg-transparent px-2 py-1 text-sm"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </Field>
              <Field label="Description">
                <textarea
                  className="w-full rounded border bg-transparent px-2 py-1 text-sm"
                  rows={2}
                  value={form.descriptionMarkdown}
                  onChange={(e) => setForm((f) => ({ ...f, descriptionMarkdown: e.target.value }))}
                />
              </Field>
              <Field label="Initial content (markdown)">
                <textarea
                  className="w-full rounded border bg-transparent px-2 py-1 text-sm font-mono"
                  rows={4}
                  value={form.initialContentMarkdown}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, initialContentMarkdown: e.target.value }))
                  }
                />
              </Field>
              <Field label="Default approval policy">
                <input
                  className="w-full rounded border bg-transparent px-2 py-1 text-sm"
                  value={form.defaultApprovalPolicy}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, defaultApprovalPolicy: e.target.value }))
                  }
                />
              </Field>
              <Field label="Default phase advance policy">
                <input
                  className="w-full rounded border bg-transparent px-2 py-1 text-sm"
                  value={form.defaultPhaseAdvancePolicy}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, defaultPhaseAdvancePolicy: e.target.value }))
                  }
                />
              </Field>
              {formError && (
                <div className="text-xs text-destructive">{formError}</div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded border px-3 py-1.5 text-sm"
                onClick={closeModal}
                disabled={formBusy}
              >
                Cancel
              </button>
              <button
                className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={onModalSubmit}
                disabled={formBusy}
              >
                {formBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Run all tests to see if PlanTemplates tests pass**

```bash
cd /home/pk/paperclip/ui && pnpm exec vitest run src/pages/__tests__/PlanTemplates.test.tsx 2>&1 | tail -30
```

Expected: PASS all 3 tests.

---

## Task 5: Register route in App.tsx

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the lazy import (after the `AdminLearning` line at ~line 72)**

```tsx
const PlanTemplates = lazyNamed(() => import("./pages/PlanTemplates"), "PlanTemplates");
```

- [ ] **Step 2: Add the route (after the `admin/learning` route at ~line 171)**

```tsx
<Route path="admin/plan-templates" element={<PlanTemplates />} />
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /home/pk/paperclip/ui && pnpm exec tsc --noEmit --skipLibCheck 2>&1 | grep -E "PlanTemplates|error" | head -10
```

Expected: No errors related to PlanTemplates.

---

## Task 6: Wire IssueDetail — Apply playbook button

**Files:**
- Modify: `ui/src/pages/IssueDetail.tsx`

Context: IssueDetail's Plan tab at line 3912 just renders `<PlanTab issueId={issue.id} planId={null} />`. The task asks for a suggested-playbooks panel with `[Apply]` buttons. Since no existing playbook suggestion panel exists in IssueDetail today, we add a minimal "Apply playbook" helper panel in the Plan tab content area.

- [ ] **Step 1: Add the applyPlaybookToIssue import at the top of IssueDetail.tsx**

Find the last import block (imports from `@/components/ui/dialog` etc around line 97-104) and add:

```tsx
import { applyPlaybookToIssue } from "@/api/plan-templates";
import { listPlaybooks } from "@/api/learning";
```

- [ ] **Step 2: Add `ApplyPlaybookPanel` component at end of file (before the last closing brace)**

Append a new component at the bottom of `IssueDetail.tsx`:

```tsx
// --- Apply-playbook panel (EO-P2-17) ---
function ApplyPlaybookPanel({ issueId, companyId }: { issueId: string; companyId: string }) {
  const [playbooks, setPlaybooks] = useState<import("@/api/learning").PlaybookRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [mergeStrategy, setMergeStrategy] = useState<"merge" | "replace">("merge");
  const [result, setResult] = useState<{ playbookId: string; addedCount: number; skippedCount: number } | null>(null);

  useEffect(() => {
    listPlaybooks(companyId, { status: "active" })
      .then((r) => setPlaybooks(r.playbooks))
      .catch(() => setPlaybooks([]));
  }, [companyId]);

  const onApply = async (playbookId: string) => {
    setBusy(playbookId);
    setResult(null);
    try {
      const res = await applyPlaybookToIssue(companyId, issueId, playbookId, mergeStrategy);
      setResult({ playbookId, ...res });
    } catch {
      // ignore — surface nothing for now
    } finally {
      setBusy(null);
    }
  };

  if (playbooks.length === 0) return null;

  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Apply playbook
      </h3>
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">Merge strategy:</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mergeStrategy"
            value="merge"
            checked={mergeStrategy === "merge"}
            onChange={() => setMergeStrategy("merge")}
          />
          Merge
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mergeStrategy"
            value="replace"
            checked={mergeStrategy === "replace"}
            onChange={() => setMergeStrategy("replace")}
          />
          Replace
        </label>
      </div>
      <ul className="space-y-1">
        {playbooks.map((pb) => (
          <li key={pb.id} className="flex items-center gap-2 rounded border bg-card p-2 text-sm">
            <span className="flex-1 font-medium">{pb.title}</span>
            {result?.playbookId === pb.id && (
              <span className="text-xs text-muted-foreground">
                +{result.addedCount} outcomes · {result.skippedCount} skipped
              </span>
            )}
            <button
              className="rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              onClick={() => onApply(pb.id)}
              disabled={busy === pb.id}
            >
              {busy === pb.id ? "Applying…" : "Apply"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: In the Plan tab content (around line 3912), add the panel**

Change:
```tsx
        <TabsContent value="plan">
          {detailTab === "plan" ? (
            <PlanTab issueId={issue.id} planId={null} />
          ) : null}
        </TabsContent>
```

To:
```tsx
        <TabsContent value="plan">
          {detailTab === "plan" ? (
            <div className="space-y-2">
              <PlanTab issueId={issue.id} planId={null} />
              <ApplyPlaybookPanel issueId={issue.id} companyId={issue.companyId} />
            </div>
          ) : null}
        </TabsContent>
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /home/pk/paperclip/ui && pnpm exec tsc --noEmit --skipLibCheck 2>&1 | grep "IssueDetail\|plan-templates\|learning" | head -20
```

Expected: No errors for the new additions.

---

## Task 7: Wire PlanDetail — PlanTemplatePicker in header

**Files:**
- Modify: `ui/src/pages/PlanDetail.tsx`

- [ ] **Step 1: Add import at the top of PlanDetail.tsx (after existing imports)**

```tsx
import { PlanTemplatePicker } from "@/components/PlanTemplatePicker";
```

- [ ] **Step 2: Add state for selected template id (inside PlanDetail function, after existing useState calls)**

```tsx
const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
```

- [ ] **Step 3: Render the picker in the PlanDetail JSX — add after the `<PlanHeader plan={plan} />` line**

```tsx
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Template:</span>
        <PlanTemplatePicker
          companyId={companyId}
          value={selectedTemplateId}
          onChange={setSelectedTemplateId}
        />
      </div>
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /home/pk/paperclip/ui && pnpm exec tsc --noEmit --skipLibCheck 2>&1 | grep "PlanDetail\|PlanTemplatePicker" | head -20
```

Expected: No errors.

---

## Task 8: Run all tests + full tsc check

- [ ] **Step 1: Run the two new test files**

```bash
cd /home/pk/paperclip/ui && pnpm exec vitest run src/pages/__tests__/PlanTemplates.test.tsx src/components/__tests__/PlanTemplatePicker.test.tsx 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 2: Full tsc**

```bash
pnpm --filter @paperclipai/ui exec tsc --noEmit 2>&1 | tail -30
```

Expected: No new errors introduced by this work.

---

## Task 9: Commit

- [ ] **Step 1: Stage all new and modified files**

```bash
git add \
  ui/src/api/plan-templates.ts \
  ui/src/pages/PlanTemplates.tsx \
  ui/src/components/PlanTemplatePicker.tsx \
  ui/src/pages/__tests__/PlanTemplates.test.tsx \
  ui/src/components/__tests__/PlanTemplatePicker.test.tsx \
  ui/src/App.tsx \
  ui/src/pages/IssueDetail.tsx \
  ui/src/pages/PlanDetail.tsx
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(ui): plan templates page + picker + apply-playbook (EO-P2-17)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Push**

```bash
git push -u origin enforced-outcomes-p2/17-ui-templates-and-playbook
```
