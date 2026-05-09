import { describe, expect, it, vi } from "vitest";
import { suggestPlaybooks } from "../suggest.js";

describe("suggestPlaybooks", () => {
  it("delegates to svc.suggestPlaybooks with threshold + limit defaults", async () => {
    const svc = {
      suggestPlaybooks: vi.fn(async () => []),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await suggestPlaybooks(svc, { callerCompanyId: "co-1" }, {
      companyId: "co-1",
      issueContext: { title: "x", labels: [] },
    });
    const call = svc.suggestPlaybooks.mock.calls[0][1];
    expect(call.threshold).toBe(0.3);
    expect(call.limit).toBe(3);
  });

  it("honors explicit overrides", async () => {
    const svc = {
      suggestPlaybooks: vi.fn(async () => []),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await suggestPlaybooks(svc, { callerCompanyId: "co-1" }, {
      companyId: "co-1",
      issueContext: { title: "x", labels: [] },
      threshold: 0.5,
      limit: 1,
    });
    const call = svc.suggestPlaybooks.mock.calls[0][1];
    expect(call.threshold).toBe(0.5);
    expect(call.limit).toBe(1);
  });

  it("reads env overrides", async () => {
    process.env.LEARNING_SUGGEST_THRESHOLD = "0.6";
    process.env.LEARNING_SUGGEST_LIMIT = "2";
    try {
      const svc = {
        suggestPlaybooks: vi.fn(async () => []),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await suggestPlaybooks(svc, { callerCompanyId: "co-1" }, {
        companyId: "co-1",
        issueContext: { title: "x", labels: [] },
      });
      const call = svc.suggestPlaybooks.mock.calls[0][1];
      expect(call.threshold).toBe(0.6);
      expect(call.limit).toBe(2);
    } finally {
      delete process.env.LEARNING_SUGGEST_THRESHOLD;
      delete process.env.LEARNING_SUGGEST_LIMIT;
    }
  });
});
