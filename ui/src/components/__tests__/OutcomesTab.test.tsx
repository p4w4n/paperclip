// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomesTab } from "../OutcomesTab";

vi.mock("../../api/outcomes", () => ({
  listOutcomes: async () => [
    {
      id: "1",
      kind: "artifact_declared",
      requiredMeta: { name: "patch" },
      status: "pending",
    },
    {
      id: "2",
      kind: "approval_granted",
      requiredMeta: { name: "legal" },
      status: "verified",
      verifiedMeta: { approval_id: "appr-1" },
      verifiedAt: "2025-01-01T00:00:00Z",
    },
    {
      id: "3",
      kind: "manual_signoff",
      requiredMeta: { name: "ack" },
      status: "reverted",
      revertedAt: "2025-01-02T00:00:00Z",
    },
  ],
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
