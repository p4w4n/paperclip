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
