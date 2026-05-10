// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outcomes } from "./Outcomes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("/instance/outcomes admin page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    document.body.removeChild(container);
  });

  it("lists outcomes across companies with target/kind/status", async () => {
    const mockOutcomes = [
      {
        id: "oc-1",
        companyId: "company-aaaaaaaaa",
        targetKind: "issue",
        targetId: "issue-bbbbbbbbb",
        kind: "manual_signoff",
        status: "pending",
        verifiedAt: null,
      },
      {
        id: "oc-2",
        companyId: "company-aaaaaaaaa",
        targetKind: "issue",
        targetId: "issue-ccccccccc",
        kind: "artifact_declared",
        status: "verified",
        verifiedAt: "2026-05-01T10:00:00Z",
      },
      {
        id: "oc-3",
        companyId: "company-ddddddddd",
        targetKind: "issue",
        targetId: "issue-eeeeeeeee",
        kind: "manual_signoff",
        status: "pending",
        verifiedAt: null,
      },
    ];

    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ outcomes: mockOutcomes }),
    } as Response);

    await act(async () => {
      root = createRoot(container);
      root.render(<Outcomes />);
    });

    await flushReact();

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);

    // Verify first row content
    const firstRowCells = rows[0]!.querySelectorAll("td");
    expect(firstRowCells[2]!.textContent).toBe("manual_signoff");
    expect(firstRowCells[3]!.textContent).toBe("pending");

    // Verify second row has verified status
    const secondRowCells = rows[1]!.querySelectorAll("td");
    expect(secondRowCells[2]!.textContent).toBe("artifact_declared");
    expect(secondRowCells[3]!.textContent).toBe("verified");
  });

  it("shows loading state initially", async () => {
    // Never resolve the fetch — keep loading
    let resolvePromise: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolvePromise = resolve;
    });
    vi.spyOn(global, "fetch").mockReturnValueOnce(fetchPromise);

    await act(async () => {
      root = createRoot(container);
      root.render(<Outcomes />);
    });

    expect(container.textContent).toContain("Loading");

    // Clean up
    resolvePromise!({
      ok: true,
      json: async () => ({ outcomes: [] }),
    } as Response);
    await flushReact();
  });

  it("shows empty state when no outcomes", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ outcomes: [] }),
    } as Response);

    await act(async () => {
      root = createRoot(container);
      root.render(<Outcomes />);
    });

    await flushReact();

    expect(container.textContent).toContain("No outcomes recorded yet");
  });
});
