import { describe, it, expect } from "vitest";
import { sharedSecretAuthStrategy, type WorkerAuthStrategy } from "../auth.js";

describe("sharedSecretAuthStrategy", () => {
  const strat: WorkerAuthStrategy = sharedSecretAuthStrategy({ secret: "s3cret" });

  it("accepts a matching bearer token", async () => {
    const result = await strat.verify("Bearer s3cret");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe("shared_secret");
  });

  it("rejects mismatched secret", async () => {
    const result = await strat.verify("Bearer wrong");
    expect(result.ok).toBe(false);
  });

  it("rejects missing bearer prefix", async () => {
    const result = await strat.verify("s3cret");
    expect(result.ok).toBe(false);
  });
});
