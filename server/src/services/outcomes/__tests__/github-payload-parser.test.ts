import { describe, expect, it } from "vitest";
import { parseGithubPrEvent, extractIssueIdentifier } from "../webhooks/github-payload-parser.js";

const samplePayload = (overrides: any = {}) => ({
  action: "closed",
  pull_request: {
    merged: true,
    number: 123,
    title: "LAK-735: fix the thing",
    body: "Resolves LAK-735.\n\nLong description.",
    head: { ref: "feature/lak-735-fix" },
    html_url: "https://github.com/example/repo/pull/123",
  },
  ...overrides,
});

describe("parseGithubPrEvent", () => {
  it("returns kind=merged for action=closed + merged=true", () => {
    expect(parseGithubPrEvent(samplePayload()).kind).toBe("merged");
  });

  it("returns kind=ignored for action=opened", () => {
    expect(parseGithubPrEvent(samplePayload({ action: "opened" })).kind).toBe("ignored");
  });

  it("returns kind=ignored for action=closed but merged=false", () => {
    expect(parseGithubPrEvent(samplePayload({
      pull_request: { ...samplePayload().pull_request, merged: false },
    })).kind).toBe("ignored");
  });

  it("returns kind=invalid_payload when pull_request is missing", () => {
    expect(parseGithubPrEvent({ action: "closed" } as any).kind).toBe("invalid_payload");
  });
});

describe("extractIssueIdentifier", () => {
  it("matches PAPERCLIP-style identifier in PR title", () => {
    expect(extractIssueIdentifier(samplePayload(), "LAK")).toBe("LAK-735");
  });

  it("matches identifier in PR body when title is plain", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "This resolves LAK-735.",
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });

  it("falls back to matching identifier in branch name", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "",
        head: { ref: "lak-735-fix" },
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });

  it("returns null when no identifier present anywhere", () => {
    const payload = samplePayload({
      pull_request: {
        ...samplePayload().pull_request,
        title: "fix the thing",
        body: "no identifier here",
        head: { ref: "feature/no-id" },
      },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBeNull();
  });

  it("is case-insensitive when matching against a known prefix", () => {
    const payload = samplePayload({
      pull_request: { ...samplePayload().pull_request, title: "fix lak-735" },
    });
    expect(extractIssueIdentifier(payload, "LAK")).toBe("LAK-735");
  });
});
