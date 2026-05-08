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

// Routes on `mode`. v1 only supports ephemeral; filestore throws
// explicitly so a misconfigured workspace surfaces as a clear RunFailed
// rather than silently degrading.
export async function realizeWorkspace(desc: WorkspaceDescriptor): Promise<RealizedWorkspace> {
  const mode = desc.mode ?? "ephemeral";
  if (mode === "ephemeral") return realizeEphemeralWorkspace(desc);
  throw new Error(`workspace mode ${mode} not supported in v1`);
}
