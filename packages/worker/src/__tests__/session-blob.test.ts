// Plan 5 worker-side: resolve sessionRestore from either inline bytes
// (Plan 1 default) or the new sessionRestoreUri field. URI wins when
// both are populated. Pure function over (dispatch.session*, fetch);
// tests don't need a real network.

import { describe, it, expect, vi } from "vitest";
import { resolveSessionRestore } from "../session-blob.js";

describe("resolveSessionRestore", () => {
  it("uses inline bytes when sessionRestoreUri is empty", async () => {
    const fetch = vi.fn();
    const out = await resolveSessionRestore({
      sessionRestore: new Uint8Array([1, 2, 3]),
      sessionRestoreUri: "",
      fetch,
    });
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches sessionRestoreUri when set, even if inline bytes are also present", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://signed.example/x");
      return new Uint8Array([9, 9, 9]);
    });
    const out = await resolveSessionRestore({
      sessionRestore: new Uint8Array([1, 2, 3]),
      sessionRestoreUri: "https://signed.example/x",
      fetch,
    });
    expect(out).toEqual(new Uint8Array([9, 9, 9]));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns empty Uint8Array when neither is set", async () => {
    const fetch = vi.fn();
    const out = await resolveSessionRestore({
      sessionRestore: new Uint8Array(),
      sessionRestoreUri: "",
      fetch,
    });
    expect(out.length).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates fetch errors as throws (caller decides RunFailed)", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("signed URL expired");
    });
    await expect(
      resolveSessionRestore({
        sessionRestore: new Uint8Array(),
        sessionRestoreUri: "https://signed.example/x",
        fetch,
      }),
    ).rejects.toThrow(/signed URL expired/);
  });
});
