import fs from "node:fs";
import path from "node:path";

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  try {
    target.add(fs.realpathSync(candidate));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const ignorePaths = new Set<string>();

  for (const relativePath of ["../ui/node_modules", "../ui/.vite", "../ui/dist"]) {
    addIgnorePath(ignorePaths, path.resolve(serverRoot, relativePath));
  }

  return [...ignorePaths];
}
