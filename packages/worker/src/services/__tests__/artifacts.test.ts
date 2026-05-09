import { describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  ArtifactDeclareAckSchema,
  type WorkerToServer,
} from "@paperclipai/worker-rpc";
import { ArtifactDeclarer } from "../artifacts.js";

describe("ArtifactDeclarer", () => {
  it("sends an ArtifactDeclared frame and resolves on matching ack", async () => {
    const sent: WorkerToServer[] = [];
    const send = vi.fn(async (m: WorkerToServer) => {
      sent.push(m);
    });
    const declarer = new ArtifactDeclarer(send);

    const promise = declarer.declareArtifact({
      runId: "r-1",
      kind: "code.file",
      name: "src/foo.ts",
      contentType: "text/plain",
      contentBytes: new TextEncoder().encode("hello"),
    });

    // Pretend the server replied.
    declarer.resolveAck(
      create(ArtifactDeclareAckSchema, {
        runId: "r-1",
        name: "src/foo.ts",
        artifactId: "art-1",
        superseded: false,
        previewQueued: false,
        error: "",
      }),
    );

    const result = await promise;
    expect(result).toEqual({ artifactId: "art-1", superseded: false, previewQueued: false });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.case).toBe("artifactDeclared");
  });

  it("rejects when the ack carries an error", async () => {
    const declarer = new ArtifactDeclarer(async () => {});
    const promise = declarer.declareArtifact({
      runId: "r-1",
      kind: "nonsense",
      name: "x",
      contentType: "text/plain",
      contentBytes: new TextEncoder().encode("y"),
    });
    declarer.resolveAck(
      create(ArtifactDeclareAckSchema, {
        runId: "r-1",
        name: "x",
        artifactId: "",
        superseded: false,
        previewQueued: false,
        error: "unknown kind",
      }),
    );
    await expect(promise).rejects.toThrow(/unknown kind/);
  });

  it("rejects on timeout", async () => {
    const declarer = new ArtifactDeclarer(async () => {});
    const promise = declarer.declareArtifact({
      runId: "r-1",
      kind: "code.file",
      name: "x",
      contentType: "text/plain",
      contentBytes: new TextEncoder().encode("y"),
      deadlineMs: 30,
    });
    await expect(promise).rejects.toThrow(/timeout/);
  });

  it("rejects empty body", async () => {
    const declarer = new ArtifactDeclarer(async () => {});
    await expect(
      declarer.declareArtifact({
        runId: "r-1",
        kind: "code.file",
        name: "x",
        contentType: "text/plain",
        contentBytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/empty/);
  });

  it("rejects oversized body", async () => {
    const declarer = new ArtifactDeclarer(async () => {});
    await expect(
      declarer.declareArtifact({
        runId: "r-1",
        kind: "code.file",
        name: "x",
        contentType: "text/plain",
        contentBytes: new Uint8Array(17 * 1024 * 1024),
      }),
    ).rejects.toThrow(/exceeds/);
  });
});
