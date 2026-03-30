#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./dev-service-profile.ts";

type WorkspaceLinkMismatch = {
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function resolveWorkspacePackagePath(packageName: string): string | null {
  if (packageName === "@paperclipai/adapter-utils") {
    return path.join(repoRoot, "packages", "adapter-utils");
  }
  if (packageName === "@paperclipai/db") {
    return path.join(repoRoot, "packages", "db");
  }
  if (packageName === "@paperclipai/shared") {
    return path.join(repoRoot, "packages", "shared");
  }
  if (packageName === "@paperclipai/plugin-sdk") {
    return path.join(repoRoot, "packages", "plugins", "sdk");
  }
  if (packageName.startsWith("@paperclipai/adapter-")) {
    return path.join(repoRoot, "packages", "adapters", packageName.slice("@paperclipai/adapter-".length));
  }
  return null;
}

function findServerWorkspaceLinkMismatches(): WorkspaceLinkMismatch[] {
  const serverPackageJson = readJsonFile(path.join(repoRoot, "server", "package.json"));
  const dependencies = {
    ...(serverPackageJson.dependencies as Record<string, unknown> | undefined),
    ...(serverPackageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = resolveWorkspacePackagePath(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(repoRoot, "server", "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === path.resolve(expectedPath)) continue;

    mismatches.push({
      packageName,
      expectedPath: path.resolve(expectedPath),
      actualPath,
    });
  }

  return mismatches;
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

async function ensureServerWorkspaceLinksCurrent() {
  const mismatches = findServerWorkspaceLinkMismatches();
  if (mismatches.length === 0) return;

  console.log("[paperclip] detected stale workspace package links for server; relinking dependencies...");
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await runCommand(
    pnpmBin,
    ["install", "--force", "--config.confirmModulesPurge=false"],
    repoRoot,
  );

  const remainingMismatches = findServerWorkspaceLinkMismatches();
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all server package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

await ensureServerWorkspaceLinksCurrent();
