import { describe, expect, it, vi } from "vitest";
import { findParentForName } from "../parent-chain.js";

function fakeDb(rows: Array<{ id: string }>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    })) as any,
  };
}

describe("findParentForName", () => {
  it("returns null when no rows match", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb([]) as any;
    const out = await findParentForName({
      db,
      companyId: "co-1",
      issueId: "iss-1",
      name: "src/foo.ts",
    });
    expect(out).toBeNull();
  });

  it("returns the latest id when one exists", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb([{ id: "art-7" }]) as any;
    const out = await findParentForName({
      db,
      companyId: "co-1",
      issueId: "iss-1",
      name: "src/foo.ts",
    });
    expect(out).toBe("art-7");
  });

  it("handles null issueId scope", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = fakeDb([{ id: "art-9" }]) as any;
    const out = await findParentForName({
      db,
      companyId: "co-1",
      issueId: null,
      name: "weekly-report",
    });
    expect(out).toBe("art-9");
  });
});
