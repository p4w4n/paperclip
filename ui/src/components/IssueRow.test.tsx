// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueRow } from "./IssueRow";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("suppresses accent hover styling when the row is selected", () => {
    const root = createRoot(container);
    const issue = {
      id: "issue-1",
      identifier: "PAP-1",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      goalId: null,
      parentId: null,
      title: "Inbox item",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      issueNumber: 1,
      requestDepth: 0,
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      hiddenAt: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
      labels: [],
      labelIds: [],
      myLastTouchAt: null,
      lastExternalCommentAt: null,
      isUnreadForMe: false,
    } as const;

    act(() => {
      root.render(<IssueRow issue={issue} selected />);
    });

    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.className).toContain("hover:bg-transparent");
    expect(link?.className).not.toContain("hover:bg-accent/50");

    act(() => {
      root.unmount();
    });
  });
});
