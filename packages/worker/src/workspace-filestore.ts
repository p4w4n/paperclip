// Plan 4 worker-side: filestore-mode workspace realization. Companion
// to packages/worker/src/workspace.ts (ephemeral, shallow-clone): this
// path takes a shared filesystem path mounted at PAPERCLIP_FILESTORE_
// ROOT on every worker and resolves the workspace cwd directly. No
// clone, no per-run temp dir. Cleanup is a no-op because the workspace
// is shared across runs — we never delete a shared path.

import { existsSync } from "node:fs";
import path from "node:path";
import type { RealizedWorkspace } from "./run-handler.js";

export interface RealizeFilestoreWorkspaceInput {
  filestoreRoot: string;
  sharedWorkspaceKey: string;
}

export async function realizeFilestoreWorkspace(
  input: RealizeFilestoreWorkspaceInput,
): Promise<RealizedWorkspace> {
  if (!existsSync(input.filestoreRoot)) {
    throw new Error(
      `filestore root ${input.filestoreRoot} does not exist on this worker — check PAPERCLIP_FILESTORE_ROOT`,
    );
  }
  // Path traversal guard: if sharedWorkspaceKey contains "..", the
  // resolved cwd could escape filestoreRoot. The control plane should
  // sanitize keys at write time; defense-in-depth here.
  const cwd = path.resolve(input.filestoreRoot, input.sharedWorkspaceKey);
  const normalizedRoot = path.resolve(input.filestoreRoot);
  if (!cwd.startsWith(normalizedRoot + path.sep) && cwd !== normalizedRoot) {
    throw new Error(
      `sharedWorkspaceKey ${input.sharedWorkspaceKey} resolves outside filestore root (path traversal)`,
    );
  }
  return {
    cwd,
    cleanup: async () => {
      // No-op. The filestore path is shared across runs and outlives
      // the worker process; deleting it would orphan every other run
      // on the same workspace.
    },
  };
}
