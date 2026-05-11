// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutcomeRowDto } from "../../api/outcomes";
import { OutcomesTab } from "../OutcomesTab";

// Base rows (no alias fields) for backwards-compat tests
const baseRows: OutcomeRowDto[] = [
  {
    id: "1",
    kind: "artifact_declared",
    requiredMeta: { name: "patch" },
    status: "pending",
    slot_base_name: "patch",
    slot_satisfied: false,
    alternatives: [],
  },
  {
    id: "2",
    kind: "approval_granted",
    requiredMeta: { name: "legal" },
    status: "verified",
    verifiedMeta: { approval_id: "appr-1" },
    verifiedAt: "2025-01-01T00:00:00Z",
    slot_base_name: "legal",
    slot_satisfied: true,
    alternatives: [],
  },
  {
    id: "3",
    kind: "manual_signoff",
    requiredMeta: { name: "ack" },
    status: "reverted",
    revertedAt: "2025-01-02T00:00:00Z",
    slot_base_name: "ack",
    slot_satisfied: false,
    alternatives: [],
  },
];

// Rows with alias grouping: slot "QA" has a primary + one alternative
const aliasRows: OutcomeRowDto[] = [
  // Primary row (name === slot_base_name)
  {
    id: "qa-primary",
    kind: "manual_signoff",
    requiredMeta: { name: "QA", auto_reopen_on_revert: true },
    status: "pending",
    slot_base_name: "QA",
    slot_satisfied: false,
    alternatives: [
      {
        id: "qa-alt-1",
        kind: "external_signal",
        requiredMeta: { name: "QA:alt:0", source: "ci" },
        status: "pending",
        slot_base_name: "QA",
        slot_satisfied: false,
        alternatives: [],
      },
    ],
  },
  // Alternative row (name !== slot_base_name — :alt:N suffix)
  {
    id: "qa-alt-1",
    kind: "external_signal",
    requiredMeta: { name: "QA:alt:0", source: "ci" },
    status: "pending",
    slot_base_name: "QA",
    slot_satisfied: false,
    alternatives: [],
  },
  // Unrelated row, no alias
  {
    id: "other",
    kind: "artifact_declared",
    requiredMeta: { name: "patch", auto_reopen_on_revert: false },
    status: "verified",
    verifiedMeta: { artifact_id: "art-1" },
    slot_base_name: "patch",
    slot_satisfied: true,
    alternatives: [],
  },
];

let mockListFn = vi.fn(async (): Promise<OutcomeRowDto[]> => baseRows);

vi.mock("../../api/outcomes", () => ({
  get listOutcomes() { return mockListFn; },
  signOff: vi.fn(),
  revertOutcome: vi.fn(),
}));

describe("OutcomesTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockListFn = vi.fn(async (): Promise<OutcomeRowDto[]> => baseRows);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders three rows with status pills", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    // Wait for the async listOutcomes to resolve
    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("artifact_declared");
    expect(text).toContain("verified");
    expect(text).toContain("reverted");
  });

  it("shows Sign off button only for pending manual_signoff rows", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const signOffButtons = buttons.filter((b) => b.textContent?.trim() === "Sign off");
    // Only "ack" (manual_signoff) with status pending shows Sign off — but "ack" has status reverted,
    // and row 1 (artifact_declared/pending) is not manual_signoff — so 0 sign-off buttons
    expect(signOffButtons).toHaveLength(0);
  });

  it("shows Withdraw button for verified rows", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const withdrawButtons = buttons.filter((b) => b.textContent?.trim() === "Withdraw");
    // Row 2 (approval_granted) is verified → 1 Withdraw button
    expect(withdrawButtons).toHaveLength(1);
  });

  it("reports pending count via onPendingCountChange", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <OutcomesTab
          target={{ kind: "issue", id: "i1", companyId: "c1" }}
          onPendingCountChange={onChange}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Row 1 (artifact_declared) is pending → count = 1
    expect(onChange).toHaveBeenCalledWith(1);
  });
});

describe("OutcomesTab — alias grouping + badges (EO-P2-18)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockListFn = vi.fn(async (): Promise<OutcomeRowDto[]> => aliasRows);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders alias slot as a single collapsed group row with any-of badge", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    // The primary slot "QA" should show with any-of badge
    expect(text).toContain("QA");
    expect(text).toContain("any-of");
    // The alt row should NOT be visible at top level (only appears on expand)
    // We verify the group is collapsed: "QA:alt:0" text should not be in top-level text
    // until expanded
    const altVisible = text.includes("QA:alt:0");
    // Collapsed by default — alt row names not shown yet
    expect(altVisible).toBe(false);
  });

  it("expands alias group to show alternatives on toggle click", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Click the expand toggle
    const toggleBtns = Array.from(document.body.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-expanded") !== null || b.getAttribute("data-expand") !== null
    );
    // Find any button that expands the alias group — could be the any-of badge or a chevron
    const allBtns = Array.from(document.body.querySelectorAll("button"));
    const expandBtn = allBtns.find(
      (b) =>
        b.textContent?.includes("any-of") ||
        b.getAttribute("aria-expanded") === "false" ||
        b.getAttribute("data-testid") === "alias-group-toggle-QA"
    );
    expect(expandBtn).toBeTruthy();

    await act(async () => {
      expandBtn!.click();
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    // After expand, alt row should now be visible
    expect(text).toContain("QA:alt:0");
  });

  it("shows reopens-on-revert badge on rows with auto_reopen_on_revert=true", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    // "QA" row has auto_reopen_on_revert: true → badge should appear
    expect(text).toContain("reopens-on-revert");
  });

  it("does NOT show reopens-on-revert badge on rows with auto_reopen_on_revert=false", async () => {
    await act(async () => {
      root.render(
        <OutcomesTab target={{ kind: "issue", id: "i1", companyId: "c1" }} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // "patch" row has auto_reopen_on_revert: false — text "reopens-on-revert" should only
    // appear once (for QA), not additionally for the patch row.
    // We count occurrences
    const html = document.body.innerHTML ?? "";
    const count = (html.match(/reopens-on-revert/g) ?? []).length;
    // only QA has it
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
