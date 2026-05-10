import { describe, expect, it } from "vitest";
import { diffContract } from "../contract.js";

describe("diffContract", () => {
  const existing = [
    { id: "a1", kind: "artifact_declared", requiredMeta: { name: "patch" }, status: "pending" },
    { id: "a2", kind: "approval_granted",  requiredMeta: { name: "legal" }, status: "verified" },
  ];

  it("inserts new contract entries that don't exist", () => {
    const desired = [
      { kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } },
      { kind: "approval_granted",  requiredMeta: { name: "legal", approval_kind: "legal" } },
      { kind: "manual_signoff",    requiredMeta: { name: "ops-ack" } },
    ];
    const r = diffContract(existing, desired);
    expect(r.toInsert).toEqual([desired[2]]);
    expect(r.toKeep).toHaveLength(2);
    expect(r.pendingToDelete).toEqual([]);
    expect(r.droppedVerified).toEqual([]);
  });

  it("deletes pending rows that disappear from the desired contract", () => {
    const desired = [{ kind: "approval_granted", requiredMeta: { name: "legal", approval_kind: "legal" } }];
    const r = diffContract(existing, desired);
    expect(r.pendingToDelete.map((row) => row.id)).toEqual(["a1"]);
    expect(r.droppedVerified).toEqual([]);
  });

  it("keeps verified rows in the DB but reports them as droppedVerified when dropped", () => {
    const desired = [{ kind: "artifact_declared", requiredMeta: { name: "patch", artifact_kind: "code.patch" } }];
    const r = diffContract(existing, desired);
    expect(r.droppedVerified.map((row) => row.id)).toEqual(["a2"]);
  });
});
