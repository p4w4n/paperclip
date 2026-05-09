import { describe, expect, it } from "vitest";
import { SuggestCache } from "../suggest-cache.js";
import type { IssueContext } from "../types.js";

const ctx: IssueContext = { title: "Deploy failed", labels: ["deploy"] };

describe("SuggestCache", () => {
  it("get/set round trip", () => {
    const c = new SuggestCache();
    expect(c.get("co-1", ctx)).toBeNull();
    c.set("co-1", ctx, [] as never[]);
    expect(c.get("co-1", ctx)).not.toBeNull();
  });

  it("expires after TTL", async () => {
    const c = new SuggestCache(20);
    c.set("co-1", ctx, [] as never[]);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.get("co-1", ctx)).toBeNull();
  });

  it("evicts the oldest at capacity", () => {
    const c = new SuggestCache(60_000, 2);
    c.set("co-1", { ...ctx, title: "A" }, [] as never[]);
    c.set("co-1", { ...ctx, title: "B" }, [] as never[]);
    c.set("co-1", { ...ctx, title: "C" }, [] as never[]);
    expect(c.size()).toBe(2);
    expect(c.get("co-1", { ...ctx, title: "A" })).toBeNull();
    expect(c.get("co-1", { ...ctx, title: "C" })).not.toBeNull();
  });

  it("invalidateCompany drops only that company's entries", () => {
    const c = new SuggestCache();
    c.set("co-A", ctx, [] as never[]);
    c.set("co-B", ctx, [] as never[]);
    c.invalidateCompany("co-A");
    expect(c.get("co-A", ctx)).toBeNull();
    expect(c.get("co-B", ctx)).not.toBeNull();
  });

  it("normalizes label order in the key", () => {
    const c = new SuggestCache();
    const a: IssueContext = { title: "x", labels: ["a", "b", "c"] };
    const b: IssueContext = { title: "x", labels: ["c", "b", "a"] };
    c.set("co-1", a, [{ playbook: { title: "x" }, score: 0.5, reason: "" }] as never[]);
    expect(c.get("co-1", b)).not.toBeNull();
  });
});
