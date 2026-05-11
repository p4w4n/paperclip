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
