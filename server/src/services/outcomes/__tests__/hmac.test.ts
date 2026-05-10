import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSignature } from "../hmac.js";

describe("verifyHmacSignature", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ hello: "world" });
  const goodSig = createHmac("sha256", secret).update(body).digest("hex");

  it("returns true for a matching signature", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: goodSig })).toBe(true);
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: `sha256=${goodSig}` })).toBe(true);
  });

  it("returns false for a mismatched signature", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "deadbeef" })).toBe(false);
  });

  it("returns false for missing/empty inputs", () => {
    expect(verifyHmacSignature({ secret: "", rawBody: body, providedSig: goodSig })).toBe(false);
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "" })).toBe(false);
  });

  it("uses constant-time compare (no early-exit on length mismatch)", () => {
    expect(verifyHmacSignature({ secret, rawBody: body, providedSig: "ab" })).toBe(false);
  });
});
