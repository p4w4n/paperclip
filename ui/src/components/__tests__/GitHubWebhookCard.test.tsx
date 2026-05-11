// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubWebhookCard } from "../GitHubWebhookCard";

const mockDeliveries = [
  {
    id: "d1",
    deliveryId: "gh-del-1",
    eventType: "pull_request",
    action: "closed",
    prUrl: "https://github.com/org/repo/pull/1",
    signatureValid: true,
    result: "verified",
    receivedAt: "2026-01-01T10:00:00Z",
  },
  {
    id: "d2",
    deliveryId: "gh-del-2",
    eventType: "pull_request",
    action: "opened",
    prUrl: "https://github.com/org/repo/pull/2",
    signatureValid: true,
    result: "no_match",
    receivedAt: "2026-01-01T09:00:00Z",
  },
  {
    id: "d3",
    deliveryId: "gh-del-3",
    eventType: "push",
    action: null,
    prUrl: null,
    signatureValid: false,
    result: "invalid_signature",
    receivedAt: "2026-01-01T08:00:00Z",
  },
  {
    id: "d4",
    deliveryId: "gh-del-4",
    eventType: "pull_request",
    action: "closed",
    prUrl: "https://github.com/org/repo/pull/4",
    signatureValid: true,
    result: "ignored",
    receivedAt: "2026-01-01T07:00:00Z",
  },
  {
    id: "d5",
    deliveryId: "gh-del-5",
    eventType: "pull_request",
    action: "closed",
    prUrl: "https://github.com/org/repo/pull/5",
    signatureValid: true,
    result: "verified",
    receivedAt: "2026-01-01T06:00:00Z",
  },
];

vi.mock("../../api/webhooks", () => ({
  listGithubDeliveries: vi.fn(async () => mockDeliveries),
  rotateGithubSecret: vi.fn(async () => ({
    secret: "ghw_testsecret123abc",
    instructions: "Configure this as the GitHub webhook secret at your repo's Settings → Webhooks",
  })),
}));

describe("GitHubWebhookCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders deliveries list with 5 rows visible", async () => {
    await act(async () => {
      root.render(<GitHubWebhookCard companyId="c1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("gh-del-1");
    expect(text).toContain("gh-del-2");
    expect(text).toContain("gh-del-3");
    expect(text).toContain("gh-del-4");
    expect(text).toContain("gh-del-5");
  });

  it("shows a status pill for deliveries", async () => {
    await act(async () => {
      root.render(<GitHubWebhookCard companyId="c1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("verified");
    expect(text).toContain("no_match");
    expect(text).toContain("invalid_signature");
  });

  it("shows Rotate Secret button", async () => {
    await act(async () => {
      root.render(<GitHubWebhookCard companyId="c1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const rotateBtn = buttons.find((b) =>
      b.textContent?.toLowerCase().includes("rotate")
    );
    expect(rotateBtn).toBeTruthy();
  });

  it("Rotate button triggers rotate and shows new secret in modal once", async () => {
    const { rotateGithubSecret } = await import("../../api/webhooks");

    await act(async () => {
      root.render(<GitHubWebhookCard companyId="c1" />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const rotateBtn = buttons.find((b) =>
      b.textContent?.toLowerCase().includes("rotate")
    );
    expect(rotateBtn).toBeTruthy();

    await act(async () => {
      rotateBtn!.click();
      await Promise.resolve();
    });

    expect(rotateGithubSecret).toHaveBeenCalledWith("c1");

    const text = document.body.textContent ?? "";
    expect(text).toContain("ghw_testsecret123abc");
  });
});
