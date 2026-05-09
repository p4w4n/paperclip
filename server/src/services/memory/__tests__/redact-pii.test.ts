import { describe, expect, it } from "vitest";
import { redactPii, redactPiiTwoStage } from "../redact-pii.js";

describe("redactPii", () => {
  it("leaves plain text untouched", () => {
    const out = redactPii("hello world");
    expect(out.changed).toBe(false);
    expect(out.redactedKinds).toEqual([]);
  });

  it("masks emails", () => {
    const out = redactPii("Reach me at user@example.com please");
    expect(out.redacted).toContain("[REDACTED:email]");
    expect(out.redactedKinds).toContain("email");
  });

  it("masks phone numbers", () => {
    const out = redactPii("Call +1 (415) 555-2671 today");
    expect(out.redactedKinds).toContain("phone");
  });

  it("masks SSN-shaped strings", () => {
    const out = redactPii("SSN 123-45-6789 here");
    expect(out.redacted).toContain("[REDACTED:ssn]");
  });

  it("masks credit-card-shaped runs", () => {
    const out = redactPii("Card 4242 4242 4242 4242 ok");
    expect(out.redactedKinds).toContain("credit_card");
  });

  it("masks AWS access keys", () => {
    const out = redactPii("AKIAIOSFODNN7EXAMPLE in the env");
    expect(out.redactedKinds).toContain("aws_access_key");
  });

  it("masks GitHub PATs", () => {
    const out = redactPii("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(out.redactedKinds).toContain("github_pat");
  });

  it("masks IPv4 addresses", () => {
    const out = redactPii("server at 10.0.1.42 listening");
    expect(out.redactedKinds).toContain("ipv4");
  });

  it("returns multiple kinds when multiple patterns match", () => {
    const out = redactPii("email a@b.co and ip 1.2.3.4");
    expect(out.redactedKinds.sort()).toEqual(["email", "ipv4"]);
  });
});

describe("redactPiiTwoStage", () => {
  it("falls through to the noop classifier by default", async () => {
    const out = await redactPiiTwoStage("hello world");
    expect(out.changed).toBe(false);
  });

  it("merges classifier kinds with regex kinds", async () => {
    const classifier = {
      async classify(text: string) {
        return { redacted: text.replace(/Bob/g, "[REDACTED:name]"), kinds: ["name"] };
      },
    };
    const out = await redactPiiTwoStage("Bob's email is b@example.com", classifier);
    expect(out.redactedKinds.sort()).toEqual(["email", "name"]);
    expect(out.redacted).toContain("[REDACTED:name]");
  });
});
