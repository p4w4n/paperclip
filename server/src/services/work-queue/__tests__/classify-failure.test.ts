import { describe, expect, it } from "vitest";
import { classifyFailure } from "../classify-failure.js";

describe("classifyFailure", () => {
  it("classifies known transient_provider codes", () => {
    expect(classifyFailure({ errorCode: "provider_429" })).toBe("transient_provider");
    expect(classifyFailure({ errorCode: "network_timeout" })).toBe("transient_provider");
  });

  it("classifies known transient_local codes", () => {
    expect(classifyFailure({ errorCode: "lease_expired" })).toBe("transient_local");
    expect(classifyFailure({ errorCode: "worker_drain" })).toBe("transient_local");
  });

  it("classifies known poison codes", () => {
    expect(classifyFailure({ errorCode: "adapter_parse_error" })).toBe("poison");
    expect(classifyFailure({ errorCode: "schema_validation_failed" })).toBe("poison");
  });

  it("classifies quota codes", () => {
    expect(classifyFailure({ errorCode: "budget_blocked" })).toBe("quota_exceeded");
  });

  it("recognizes _permanent suffix as permanent", () => {
    expect(classifyFailure({ errorCode: "auth_failure_permanent" })).toBe("permanent");
  });

  it("falls back to message scan for transient text", () => {
    expect(
      classifyFailure({ errorCode: null, errorMessage: "fetch failed: ECONNRESET" }),
    ).toBe("transient_provider");
  });

  it("treats unknown errors as poison (don't burn retries)", () => {
    expect(classifyFailure({ errorCode: "weird_unknown" })).toBe("poison");
  });

  it("poison takes precedence over a transient message", () => {
    expect(
      classifyFailure({ errorCode: "permanent", errorMessage: "timeout" }),
    ).toBe("poison");
  });
});
