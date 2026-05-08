// Plan 5: helper that decides whether a session blob ships inline on
// the RunDispatch frame or via a signed URL. Pure function over
// (sizeBytes, threshold, putToStorage); tests pin the branching
// without DB or storage I/O.

import { describe, it, expect, vi } from "vitest";
import { resolveSessionBlob } from "../session-blob-redirect.js";

describe("resolveSessionBlob", () => {
  it("returns inline when blob is under the threshold", async () => {
    const putToStorage = vi.fn();
    const result = await resolveSessionBlob({
      sessionRestore: Buffer.from("small"),
      thresholdBytes: 100,
      putToStorage,
      runId: "r1",
    });
    expect(result.mode).toBe("inline");
    if (result.mode === "inline") {
      expect(result.bytes.toString()).toBe("small");
    }
    expect(putToStorage).not.toHaveBeenCalled();
  });

  it("uploads + returns URI when blob exceeds the threshold", async () => {
    const putToStorage = vi.fn(async () => "https://gcs.signed.example/r1.session");
    const big = Buffer.alloc(100_000, 0x42);
    const result = await resolveSessionBlob({
      sessionRestore: big,
      thresholdBytes: 1024,
      putToStorage,
      runId: "r1",
    });
    expect(result.mode).toBe("uri");
    if (result.mode === "uri") {
      expect(result.uri).toBe("https://gcs.signed.example/r1.session");
    }
    expect(putToStorage).toHaveBeenCalledOnce();
  });

  it("empty / missing blob → inline empty (no upload)", async () => {
    const putToStorage = vi.fn();
    const result = await resolveSessionBlob({
      sessionRestore: undefined,
      thresholdBytes: 1024,
      putToStorage,
      runId: "r1",
    });
    expect(result.mode).toBe("inline");
    if (result.mode === "inline") expect(result.bytes.length).toBe(0);
    expect(putToStorage).not.toHaveBeenCalled();
  });

  it("empty Buffer is treated as inline empty", async () => {
    const putToStorage = vi.fn();
    const result = await resolveSessionBlob({
      sessionRestore: Buffer.alloc(0),
      thresholdBytes: 1024,
      putToStorage,
      runId: "r1",
    });
    expect(result.mode).toBe("inline");
    expect(putToStorage).not.toHaveBeenCalled();
  });
});
