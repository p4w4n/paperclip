import { afterEach, describe, expect, it, vi } from "vitest";
import { reapExpiredPreviews } from "../reaper.js";
import {
  clearPreviewProviders,
  registerPreviewProvider,
} from "../registry.js";

afterEach(() => {
  clearPreviewProviders();
});

function fakeDb(rows: Array<{ id: string; previewProvider: string | null }>) {
  const updates: Array<{ id: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: vi.fn(async () => {
          updates.push({ id: "tracked" });
        }),
      }),
    }),
    updates,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("reapExpiredPreviews", () => {
  it("returns zeroes when nothing expired", async () => {
    const db = fakeDb([]);
    const out = await reapExpiredPreviews(db);
    expect(out).toEqual({ reaped: 0, errors: 0 });
  });

  it("clears the URL and calls provider.teardown when available", async () => {
    const teardown = vi.fn(async () => {});
    registerPreviewProvider({
      id: "local",
      supports: () => true,
      materialize: vi.fn(),
      teardown,
    });
    const db = fakeDb([{ id: "art-1", previewProvider: "local" }]);
    const out = await reapExpiredPreviews(db);
    expect(out.reaped).toBe(1);
    expect(teardown).toHaveBeenCalledWith({ artifactId: "art-1" });
  });

  it("counts errors and continues when teardown throws", async () => {
    registerPreviewProvider({
      id: "boom",
      supports: () => true,
      materialize: vi.fn(),
      teardown: async () => {
        throw new Error("teardown failed");
      },
    });
    const db = fakeDb([
      { id: "art-1", previewProvider: "boom" },
      { id: "art-2", previewProvider: "boom" },
    ]);
    const out = await reapExpiredPreviews(db);
    expect(out.reaped).toBe(2);
    expect(out.errors).toBe(2);
  });
});
