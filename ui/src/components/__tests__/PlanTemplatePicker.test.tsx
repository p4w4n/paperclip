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
