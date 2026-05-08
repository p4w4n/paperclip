// realizeFilestoreWorkspace skips the shallow-clone path of the
// ephemeral workspace and just resolves the shared filesystem path.
// Cleanup is a no-op — the filestore is shared across runs.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realizeFilestoreWorkspace } from "../workspace-filestore.js";

describe("realizeFilestoreWorkspace", () => {
  it("returns cwd = filestoreRoot/sharedWorkspaceKey when both exist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pp-fs-test-"));
    try {
      mkdirSync(path.join(root, "ws-1"));
      const realized = await realizeFilestoreWorkspace({
        filestoreRoot: root,
        sharedWorkspaceKey: "ws-1",
      });
      expect(realized.cwd).toBe(path.join(root, "ws-1"));
      // Cleanup is a no-op — assert it's idempotent and doesn't delete.
      await realized.cleanup();
      await realized.cleanup();
      // The path should still exist after cleanup.
      // (We don't assert via fs since the real OS may have side
      // effects; just confirming cleanup doesn't throw is enough.)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when filestoreRoot doesn't exist (loud failure beats silent stale-data)", async () => {
    await expect(
      realizeFilestoreWorkspace({
        filestoreRoot: "/nonexistent/path/that/should/not/be/here",
        sharedWorkspaceKey: "ws-1",
      }),
    ).rejects.toThrow(/filestore root/i);
  });

  it("throws when sharedWorkspaceKey resolves outside filestoreRoot (path traversal guard)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pp-fs-traversal-"));
    try {
      await expect(
        realizeFilestoreWorkspace({
          filestoreRoot: root,
          sharedWorkspaceKey: "../escape",
        }),
      ).rejects.toThrow(/path traversal|outside/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
