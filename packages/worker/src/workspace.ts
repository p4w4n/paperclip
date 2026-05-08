// Ephemeral workspace realization. Creates a fresh tmp dir per run,
// optionally clones a repo into it, hands back a cleanup that wipes the
// dir on completion. Aligns with the spec's "default ephemeral" workspace
// policy (workers stay stateless, autoscaling Just Works).
//
// Filestore mode (long-lived NFS-mounted workspaces with a control-plane
// lease coordinating concurrent access) is queued for the dedicated
// filestore task — the dispatcher passes a workspace descriptor and this
// realizer routes on `mode`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface RealizedWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
}

export interface WorkspaceDescriptor {
  mode?: "ephemeral" | "filestore";
  repoUrl?: string;
  ref?: string;
  // Plan 4 filestore-mode: the workspace-side identifier. The path
  // resolves to filestoreRoot/sharedWorkspaceKey at the worker;
  // filestoreRoot is per-worker via PAPERCLIP_FILESTORE_ROOT env.
  sharedWorkspaceKey?: string;
}

export async function realizeEphemeralWorkspace(
  desc: WorkspaceDescriptor,
): Promise<RealizedWorkspace> {
  const cwd = await mkdtemp(join(tmpdir(), "paperclip-run-"));
  if (desc.repoUrl) {
    // Shallow clone keeps the cold-start budget bounded. Future:
    // bare-repo cache on local SSD per spec, refreshed periodically.
    await execFile("git", ["clone", "--depth", "1", desc.repoUrl, cwd]);
    if (desc.ref) {
      // Fetch + checkout the requested ref. --depth 1 because we already
      // pulled a shallow clone; deepening on demand would inflate clone
      // time.
      await execFile("git", ["-C", cwd, "fetch", "--depth", "1", "origin", desc.ref]);
      await execFile("git", ["-C", cwd, "checkout", desc.ref]);
    }
  }
  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

// Routes on `mode`. Plan 1 wired ephemeral; Plan 4 adds filestore.
// filestore expects PAPERCLIP_FILESTORE_ROOT in env; the descriptor
// carries the per-workspace key (sharedWorkspaceKey).
export async function realizeWorkspace(desc: WorkspaceDescriptor): Promise<RealizedWorkspace> {
  const mode = desc.mode ?? "ephemeral";
  if (mode === "ephemeral") return realizeEphemeralWorkspace(desc);
  if (mode === "filestore") {
    const filestoreRoot = process.env.PAPERCLIP_FILESTORE_ROOT?.trim();
    if (!filestoreRoot) {
      throw new Error(
        "filestore mode requires PAPERCLIP_FILESTORE_ROOT env on the worker",
      );
    }
    if (!desc.sharedWorkspaceKey) {
      throw new Error("filestore mode requires sharedWorkspaceKey on the workspace descriptor");
    }
    const { realizeFilestoreWorkspace } = await import("./workspace-filestore.js");
    return realizeFilestoreWorkspace({
      filestoreRoot,
      sharedWorkspaceKey: desc.sharedWorkspaceKey,
    });
  }
  throw new Error(`workspace mode ${mode} not supported`);
}
